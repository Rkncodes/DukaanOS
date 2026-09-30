"""Salaahkaar tool registry: the ONLY way the assistant can read or change data.

An LLM (app.integrations.llm) may propose `ProposedToolCall(name, arguments)`.
`execute_tool` validates the arguments with Pydantic and calls existing module
services under the caller's TenantContext, so the assistant gets exactly the same
merchant isolation and business rules as the UI. The agent loop, prompts and
confirmation UX come in the Salaahkaar phase.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.enums import InputSource, PaymentMethod
from app.core.errors import NotFound
from app.core.tenancy import TenantContext
from app.core.types import PositiveMoney, Quantity
from app.integrations.llm import ToolSpec
from app.modules.billing import service as billing
from app.modules.billing.schemas import CartRead
from app.modules.catalog import service as catalog
from app.modules.catalog.schemas import ProductRead
from app.modules.khata import service as khata
from app.modules.khata.schemas import KhataEntryRead


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args_model: type[BaseModel]
    handler: Callable[[Session, TenantContext, Any], Any]
    mutates: bool  # mutating tools will require merchant confirmation in the UI

    def spec(self) -> ToolSpec:
        return ToolSpec(self.name, self.description, self.args_model.model_json_schema())


# ---- tool argument models ----


class SearchProductsArgs(BaseModel):
    query: str = Field(min_length=1)


class CustomerBalanceArgs(BaseModel):
    customer_id: uuid.UUID


class AddToCartArgs(BaseModel):
    cart_id: uuid.UUID
    product_id: uuid.UUID
    quantity: Quantity = Decimal(1)


class RecordKhataPaymentArgs(BaseModel):
    customer_id: uuid.UUID
    amount: PositiveMoney
    method: PaymentMethod = PaymentMethod.CASH


# ---- handlers (thin adapters over services) ----


def _search_products(db: Session, ctx: TenantContext, args: SearchProductsArgs) -> list[dict]:
    products = catalog.list_products(db, ctx, q=args.query)
    return [ProductRead.model_validate(p).model_dump(mode="json") for p in products[:20]]


def _customer_balance(db: Session, ctx: TenantContext, args: CustomerBalanceArgs) -> dict:
    return {"customer_id": str(args.customer_id), "balance": str(khata.get_balance(db, ctx, args.customer_id))}


def _add_to_cart(db: Session, ctx: TenantContext, args: AddToCartArgs) -> dict:
    cart = billing.add_item(db, ctx, args.cart_id, args.product_id, args.quantity, InputSource.ASSISTANT)
    return CartRead.model_validate(cart).model_dump(mode="json")


def _record_khata_payment(db: Session, ctx: TenantContext, args: RecordKhataPaymentArgs) -> dict:
    entry = khata.record_payment(
        db, ctx, args.customer_id, args.amount, method=args.method, source=InputSource.ASSISTANT
    )
    return KhataEntryRead.model_validate(entry).model_dump(mode="json")


TOOLS: dict[str, Tool] = {
    t.name: t
    for t in [
        Tool("search_products", "Search the store's products by name", SearchProductsArgs, _search_products, False),
        Tool("get_customer_balance", "Get a customer's khata balance", CustomerBalanceArgs, _customer_balance, False),
        Tool("add_to_cart", "Add a product to an open bill", AddToCartArgs, _add_to_cart, True),
        Tool(
            "record_khata_payment",
            "Record a customer paying back udhaar",
            RecordKhataPaymentArgs,
            _record_khata_payment,
            True,
        ),
    ]
}


def tool_specs() -> list[ToolSpec]:
    return [t.spec() for t in TOOLS.values()]


def execute_tool(db: Session, ctx: TenantContext, name: str, arguments: dict[str, Any]) -> Any:
    """Validate and run a proposed tool call. Raises pydantic.ValidationError on bad
    arguments and DomainError subclasses on business-rule violations. Caller commits."""
    tool = TOOLS.get(name)
    if tool is None:
        raise NotFound(f"Unknown tool {name}")
    return tool.handler(db, ctx, tool.args_model.model_validate(arguments))
