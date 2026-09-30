import uuid
from datetime import datetime

from app.core.enums import Channel, InputSource, OrderStatus, PaymentStatus
from app.core.types import MoneyOut, QuantityOut, Schema


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
