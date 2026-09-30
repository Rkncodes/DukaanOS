import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from app.core.enums import CartStatus, Channel, CheckoutMethod, InputSource
from app.core.types import Money, MoneyOut, Quantity, QuantityOut, Schema


class CartCreate(BaseModel):
    channel: Channel = Channel.COUNTER
    customer_id: uuid.UUID | None = None


class CartUpdate(BaseModel):
    customer_id: uuid.UUID | None


class CartItemAdd(BaseModel):
    """Identify the product by id or barcode (exactly one)."""

    product_id: uuid.UUID | None = None
    barcode: str | None = Field(default=None, max_length=64)
    quantity: Quantity = Decimal(1)
    source: InputSource = InputSource.MANUAL

    @model_validator(mode="after")
    def _exactly_one_identifier(self) -> "CartItemAdd":
        if (self.product_id is None) == (self.barcode is None):
            raise ValueError("Provide exactly one of product_id or barcode")
        return self


class CartItemUpdate(BaseModel):
    quantity: Quantity


class CartItemRead(Schema):
    id: uuid.UUID
    product_id: uuid.UUID
    product_name: str
    quantity: QuantityOut
    unit_price: MoneyOut
    line_total: MoneyOut
    source: InputSource


class CartRead(Schema):
    id: uuid.UUID
    customer_id: uuid.UUID | None
    channel: Channel
    status: CartStatus
    items: list[CartItemRead]
    subtotal: MoneyOut
    created_at: datetime
    updated_at: datetime


class CheckoutRequest(BaseModel):
    method: CheckoutMethod
    discount: Money = Decimal(0)
