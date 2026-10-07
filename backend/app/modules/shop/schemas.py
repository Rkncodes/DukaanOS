"""What the public storefront may see and send. Deliberately narrower than the merchant's own
schemas: no cost price, barcode, SKU or stock count, and nothing a customer sends is a price."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.core.enums import OrderStatus, PaymentStatus
from app.core.types import MoneyOut, Quantity, QuantityOut, Schema
from app.modules.catalog.schemas import CategoryRead

MAX_ORDER_LINES = 50  # as many lines as one Counter confirmation may add
MAX_LINE_QUANTITY = 999


class StoreRead(BaseModel):
    store_name: str
    store_slug: str
    categories: list[CategoryRead]  # only the ones that have a product on sale


class StoreProduct(BaseModel):
    id: uuid.UUID
    name: str
    price: MoneyOut
    unit: str
    image_url: str | None
    category_id: uuid.UUID | None
    in_stock: bool  # the count itself is the merchant's business


class StoreOrderItem(BaseModel):
    product_id: uuid.UUID
    quantity: Quantity = Field(le=MAX_LINE_QUANTITY)


class StoreOrderCreate(BaseModel):
    """What the customer wants. There are no prices and no totals: the backend computes them."""

    items: list[StoreOrderItem] = Field(min_length=1, max_length=MAX_ORDER_LINES)
    customer_name: str | None = Field(default=None, max_length=120)
    customer_phone: str | None = Field(default=None, max_length=20, pattern=r"^[0-9+ -]*$")

    @field_validator("customer_name", "customer_phone")
    @classmethod
    def _blank_is_not_given(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None


class StoreOrderLine(Schema):
    product_id: uuid.UUID
    product_name: str
    quantity: QuantityOut
    unit_price: MoneyOut
    line_total: MoneyOut


class StoreOrderRead(Schema):
    """The customer's view of their order."""

    id: uuid.UUID
    status: OrderStatus
    payment_status: PaymentStatus
    items: list[StoreOrderLine]
    subtotal: MoneyOut
    total: MoneyOut
    customer_name: str | None
    customer_phone: str | None
    created_at: datetime
    updated_at: datetime
