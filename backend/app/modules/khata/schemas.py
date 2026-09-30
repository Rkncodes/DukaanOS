import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.core.enums import InputSource, KhataEntryType, PaymentMethod
from app.core.types import MoneyOut, PositiveMoney, Schema
from app.modules.customers.schemas import CustomerRead


class KhataCreditCreate(BaseModel):
    amount: PositiveMoney
    description: str | None = Field(default=None, max_length=255)
    source: InputSource = InputSource.MANUAL


class KhataPaymentCreate(BaseModel):
    amount: PositiveMoney
    method: PaymentMethod = PaymentMethod.CASH
    description: str | None = Field(default=None, max_length=255)
    source: InputSource = InputSource.MANUAL


class KhataEntryRead(Schema):
    id: uuid.UUID
    customer_id: uuid.UUID
    type: KhataEntryType
    amount: MoneyOut
    description: str | None
    order_id: uuid.UUID | None
    payment_id: uuid.UUID | None
    source: InputSource
    created_at: datetime


class CustomerLedger(BaseModel):
    customer: CustomerRead
    balance: MoneyOut  # positive = customer owes the merchant
    entries: list[KhataEntryRead]


class KhataBalance(BaseModel):
    customer_id: uuid.UUID
    customer_name: str
    phone: str | None
    balance: MoneyOut
    last_entry_at: datetime | None
