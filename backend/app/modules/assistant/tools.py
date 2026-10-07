"""Salaahkaar tool registry: the ONLY way the assistant can read or change data.

An LLM (app.integrations.llm) may propose `ProposedToolCall(name, arguments)`.
`execute_tool` validates the arguments with Pydantic and calls existing module
services under the caller's TenantContext, so the assistant gets exactly the same
merchant isolation and business rules as the UI. The agent loop, prompts and
confirmation UX come in the Salaahkaar phase.
"""

import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.clock import store_day_start, store_now
from app.core.enums import Channel, InputSource, OrderStatus, PaymentMethod, PaymentStatus
from app.core.errors import NotFound
from app.core.tenancy import TenantContext
from app.core.types import PositiveMoney, Quantity
from app.integrations.llm import ToolSpec
from app.modules.billing import service as billing
from app.modules.billing.schemas import CartRead
from app.modules.catalog import service as catalog
from app.modules.catalog.models import Product
from app.modules.catalog.schemas import ProductRead
from app.modules.khata import service as khata
from app.modules.khata.schemas import KhataBalance, KhataEntryRead
from app.modules.orders import service as orders
from app.modules.orders.models import Order

LOW_STOCK = 10  # stock below this is "low": the same line the Dashboard and Catalogue draw
MOST = 10  # the most matches a lookup by name returns
LONGEST_LIST = 50  # the longest list a tool returns; the result says when there is more


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


# ---- read-only tools for questions about the store ----
#
# Each takes only what the question names (a product, a customer) and reads through the same
# services as the screens. None takes a merchant: that is the caller's TenantContext, always.


class NoArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CustomerNameArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    customer: str = Field(
        min_length=1,
        max_length=120,
        description="The customer's name or part of it, in Latin script as stored, e.g. 'Rahul Sharma'",
    )


class ProductNameArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product: str = Field(
        min_length=1,
        max_length=160,
        description="The product's name or part of it, in Latin script as stored, e.g. 'Maggi' or 'Coke'",
    )


class LowStockArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    threshold: int = Field(default=LOW_STOCK, ge=0, le=100_000, description="Stock below this counts as low")


def _money(amount: Decimal) -> str:
    return str(amount.quantize(Decimal("0.01")))


def _quantity(amount: Decimal) -> str:
    return str(amount.normalize()) if amount != amount.to_integral() else str(int(amount))


def _words(text: str) -> list[str]:
    return re.findall(r"\w+", text.casefold())


def _named(query: str, name: str) -> bool:
    """Every word asked for appears in the name ("rahul" finds "Rahul Sharma"). No guessing beyond that."""
    words = _words(query)
    name_text = " ".join(_words(name))
    return bool(words) and all(word in name_text for word in words)


def _todays_orders(db: Session, ctx: TenantContext) -> list[Order]:
    return orders.list_orders(db, ctx, since=store_day_start(), limit=None)


def _today_sales(db: Session, ctx: TenantContext, args: NoArgs) -> dict:
    """Sales are completed orders: paid ones and those put on khata. Same rule as the Dashboard."""
    sold = [o for o in _todays_orders(db, ctx) if o.status == OrderStatus.COMPLETED]
    on_khata = [o for o in sold if o.payment_status == PaymentStatus.CREDIT]

    def total(some: list[Order]) -> str:
        return _money(sum((o.total for o in some), Decimal(0)))

    return {
        "date": store_now().date().isoformat(),
        "currency": "INR",
        "total_sales": total(sold),
        "completed_sales": len(sold),
        "paid_amount": total([o for o in sold if o.payment_status == PaymentStatus.PAID]),
        "on_khata_amount": total(on_khata),
        "on_khata_sales": len(on_khata),
        "counter_amount": total([o for o in sold if o.channel == Channel.COUNTER]),
        "shop_amount": total([o for o in sold if o.channel == Channel.SHOP]),
    }


def _today_orders(db: Session, ctx: TenantContext, args: NoArgs) -> dict:
    today = _todays_orders(db, ctx)
    waiting = orders.list_orders(db, ctx, channel=Channel.SHOP, status=OrderStatus.PENDING, limit=None)
    return {
        "date": store_now().date().isoformat(),
        "total_orders_today": len(today),
        "counter_bills_today": sum(1 for o in today if o.channel == Channel.COUNTER),
        "online_shop_orders_today": sum(1 for o in today if o.channel == Channel.SHOP),
        "cancelled_today": sum(1 for o in today if o.status == OrderStatus.CANCELLED),
        "online_orders_waiting_to_be_accepted_now": len(waiting),
    }


def _total_outstanding(db: Session, ctx: TenantContext, args: NoArgs) -> dict:
    owing = khata.list_balances(db, ctx, outstanding_only=True)  # largest first
    return {
        "currency": "INR",
        "total_outstanding": _money(sum((b.balance for b in owing), Decimal(0))),
        "customers_owing": len(owing),
        "largest": [{"customer": b.customer_name, "outstanding": _money(b.balance)} for b in owing[:5]],
    }


def _balance_row(balance: KhataBalance) -> dict:
    owed = balance.balance
    return {
        "customer_id": str(balance.customer_id),
        "customer": balance.customer_name,
        "phone": balance.phone,
        "outstanding": _money(max(owed, Decimal(0))),
        "advance_paid": _money(max(-owed, Decimal(0))),
    }


def _customer_outstanding(db: Session, ctx: TenantContext, args: CustomerNameArgs) -> dict:
    matches = [b for b in khata.list_balances(db, ctx) if _named(args.customer, b.customer_name)]
    return {
        "found": bool(matches),
        "currency": "INR",
        "matches": [_balance_row(b) for b in matches[:MOST]],
        "note": "More than one customer matches: ask which one is meant." if len(matches) > 1 else None,
    }


def _matching_products(db: Session, ctx: TenantContext, name: str) -> list[Product]:
    return [p for p in catalog.list_products(db, ctx) if _named(name, p.name)]


def _product_stock(db: Session, ctx: TenantContext, args: ProductNameArgs) -> dict:
    matches = _matching_products(db, ctx, args.product)
    return {
        "found": bool(matches),
        "matches": [
            {"product": p.name, "in_stock": _quantity(p.stock_quantity), "unit": p.unit, "low": p.stock_quantity < LOW_STOCK}
            for p in matches[:MOST]
        ],
    }


def _product_price(db: Session, ctx: TenantContext, args: ProductNameArgs) -> dict:
    matches = _matching_products(db, ctx, args.product)
    return {
        "found": bool(matches),
        "currency": "INR",
        "matches": [{"product": p.name, "price": _money(p.price), "per": p.unit} for p in matches[:MOST]],
    }


def _customer_list(db: Session, ctx: TenantContext, args: NoArgs) -> dict:
    balances = sorted(khata.list_balances(db, ctx), key=lambda b: b.customer_name.casefold())
    return {
        "total_customers": len(balances),
        "currency": "INR",
        "customers": [_balance_row(b) for b in balances[:LONGEST_LIST]],
        "list_is_complete": len(balances) <= LONGEST_LIST,
    }


def _low_stock(db: Session, ctx: TenantContext, args: LowStockArgs) -> dict:
    low = sorted(
        (p for p in catalog.list_products(db, ctx) if p.stock_quantity < args.threshold),
        key=lambda p: (p.stock_quantity, p.name),
    )
    return {
        "threshold": args.threshold,
        "low_stock_products": len(low),
        "out_of_stock_products": sum(1 for p in low if p.stock_quantity <= 0),
        "products": [{"product": p.name, "in_stock": _quantity(p.stock_quantity), "unit": p.unit} for p in low[:LONGEST_LIST]],
        "list_is_complete": len(low) <= LONGEST_LIST,
    }


TOOLS: dict[str, Tool] = {
    t.name: t
    for t in [
        Tool(
            "get_today_sales",
            "Today's sales: total amount, number of completed sales, how much was paid and how much went on khata",
            NoArgs,
            _today_sales,
            False,
        ),
        Tool(
            "get_today_orders",
            "How many orders came today: counter bills, online shop orders, and online orders still waiting",
            NoArgs,
            _today_orders,
            False,
        ),
        Tool(
            "get_total_outstanding",
            "Total khata (udhaar) outstanding across all customers, how many customers owe, and who owes most",
            NoArgs,
            _total_outstanding,
            False,
        ),
        Tool(
            "get_customer_outstanding",
            "How much one customer owes on khata (udhaar), found by name",
            CustomerNameArgs,
            _customer_outstanding,
            False,
        ),
        Tool("get_product_stock", "How much stock is left of a product, found by name", ProductNameArgs, _product_stock, False),
        Tool("get_product_price", "The selling price (rate) of a product, found by name", ProductNameArgs, _product_price, False),
        Tool("get_customer_list", "How many customers the store has, and who they are", NoArgs, _customer_list, False),
        Tool(
            "get_low_stock_products",
            "Which products are low in stock or out of stock",
            LowStockArgs,
            _low_stock,
            False,
        ),
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


def tool_specs(*, read_only: bool = False) -> list[ToolSpec]:
    """Every tool, or only those that change nothing."""
    return [t.spec() for t in TOOLS.values() if not (read_only and t.mutates)]


def execute_tool(db: Session, ctx: TenantContext, name: str, arguments: dict[str, Any]) -> Any:
    """Validate and run a proposed tool call. Raises pydantic.ValidationError on bad
    arguments and DomainError subclasses on business-rule violations. Caller commits."""
    tool = TOOLS.get(name)
    if tool is None:
        raise NotFound(f"Unknown tool {name}")
    return tool.handler(db, ctx, tool.args_model.model_validate(arguments))
