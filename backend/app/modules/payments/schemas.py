import uuid
from datetime import datetime

from app.core.enums import PaymentMethod, PaymentRecordStatus
from app.core.types import MoneyOut, Schema


class PaymentRead(Schema):
    id: uuid.UUID
    order_id: uuid.UUID | None
    customer_id: uuid.UUID | None
    amount: MoneyOut
    method: PaymentMethod
    status: PaymentRecordStatus
    provider: str
    external_reference: str | None
    created_at: datetime
