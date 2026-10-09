import uuid
from datetime import datetime

from pydantic import BaseModel

from app.core.enums import Channel, InputSource, OrderStatus, PaymentMethod, PaymentStatus
from app.core.tax import TaxSummary
from app.core.types import MoneyOut, PercentOut, QuantityOut, Schema
from app.modules.customers.schemas import CustomerRead
from app.modules.khata.schemas import KhataEntryRead
from app.modules.payments.schemas import PaymentRead


class OrderItemRead(Schema):
    id: uuid.UUID
    product_id: uuid.UUID
    product_name: str
    quantity: QuantityOut
    unit_price: MoneyOut
    tax_rate: PercentOut
    line_total: MoneyOut
    source: InputSource


class OrderRead(Schema):
    id: uuid.UUID
    customer_id: uuid.UUID | None
    cart_id: uuid.UUID | None
    customer_name: str | None  # given by a Shop customer when ordering
    customer_phone: str | None
    channel: Channel
    status: OrderStatus
    subtotal: MoneyOut
    discount: MoneyOut
    total: MoneyOut
    tax_summary: TaxSummary
    payment_status: PaymentStatus
    items: list[OrderItemRead]
    created_at: datetime
    updated_at: datetime


class OrderStatusUpdate(BaseModel):
    """Move an order along its lifecycle. Which moves are allowed is decided by the backend."""

    status: OrderStatus
    # How the customer paid; needed when an unpaid order is completed (handed over).
    payment_method: PaymentMethod | None = None


class CrossSellSuggestion(Schema):
    """A product frequently bought alongside what's already in the cart, not itself in it."""

    product_id: uuid.UUID
    name: str
    price: MoneyOut
    times_bought_together: int


class BillRead(BaseModel):
    """An order plus how it was settled: what the counter shows (and prints) after checkout."""

    order: OrderRead
    customer: CustomerRead | None
    payments: list[PaymentRead]  # money received against this bill
    khata_entry: KhataEntryRead | None  # set when the bill was put on udhaar
    customer_balance: MoneyOut | None  # customer's current khata balance (positive = owes)
