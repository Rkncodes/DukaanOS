import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

from app.core.enums import PaymentMethod, PaymentRecordStatus, PaytmPaymentStatus
from app.core.types import Money, MoneyOut, Schema


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


class PaytmConfigRead(BaseModel):
    """Whether "Pay with Paytm" can be offered. No credentials."""

    enabled: bool
    environment: Literal["sandbox", "production"] | None  # null when switched off


class PaytmStart(BaseModel):
    """The bill to collect. There is no amount: the backend computes it from the cart."""

    cart_id: uuid.UUID
    discount: Money = Decimal(0)


class PaytmPaymentRead(Schema):
    """One Paytm attempt for a bill, as verified by the backend."""

    id: uuid.UUID
    cart_id: uuid.UUID | None
    order_id: uuid.UUID | None  # the completed bill, once paid
    status: PaytmPaymentStatus
    environment: str
    amount: MoneyOut
    discount: MoneyOut
    paytm_order_id: str
    txn_id: str | None  # Paytm's transaction reference
    bank_txn_id: str | None
    payment_mode: str | None
    result_code: str | None
    result_msg: str | None  # Paytm's own words about the transaction
    detail: str | None  # why a received payment still needs the merchant
    verified_at: datetime | None
    created_at: datetime
    updated_at: datetime


class PaytmCheckout(BaseModel):
    """What Paytm's JS Checkout needs in the browser. The merchant key is never part of this."""

    host: str
    mid: str
    order_id: str
    txn_token: str
    amount: MoneyOut


class PaytmStartRead(BaseModel):
    payment: PaytmPaymentRead
    checkout: PaytmCheckout
