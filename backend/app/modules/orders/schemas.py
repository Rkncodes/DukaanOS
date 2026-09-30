import uuid
from datetime import datetime

from pydantic import BaseModel

from app.core.enums import Channel, InputSource, OrderStatus, PaymentStatus
from app.core.types import MoneyOut, QuantityOut, Schema
from app.modules.customers.schemas import CustomerRead
from app.modules.khata.schemas import KhataEntryRead
from app.modules.payments.schemas import PaymentRead


class OrderItemRead(Schema):
    id: uuid.UUID
    product_id: uuid.UUID
    product_name: str
    quantity: QuantityOut
    unit_price: MoneyOut
    line_total: MoneyOut
    source: InputSource


class OrderRead(Schema):
    id: uuid.UUID
    customer_id: uuid.UUID | None
    cart_id: uuid.UUID | None
    channel: Channel
    status: OrderStatus
    subtotal: MoneyOut
    discount: MoneyOut
    total: MoneyOut
    payment_status: PaymentStatus
    items: list[OrderItemRead]
    created_at: datetime
    updated_at: datetime


class BillRead(BaseModel):
    """An order plus how it was settled: what the counter shows (and prints) after checkout."""

    order: OrderRead
    customer: CustomerRead | None
    payments: list[PaymentRead]  # money received against this bill
    khata_entry: KhataEntryRead | None  # set when the bill was put on udhaar
    customer_balance: MoneyOut | None  # customer's current khata balance (positive = owes)
