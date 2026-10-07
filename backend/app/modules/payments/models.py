import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, CreatedAt, MerchantScoped, Timestamps, UUIDPk
from app.core.enums import PaymentMethod, PaymentRecordStatus, PaytmPaymentStatus, enum_check


class Payment(UUIDPk, MerchantScoped, CreatedAt, Base):
    """Money actually received (or attempted). Khata/udhaar sales create no Payment."""

    __tablename__ = "payments"
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        enum_check("method", PaymentMethod),
        enum_check("status", PaymentRecordStatus),
    )

    order_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("orders.id"), index=True)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("customers.id"), index=True)
    amount: Mapped[Decimal]
    method: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20))
    provider: Mapped[str] = mapped_column(String(40))  # which PaymentProvider handled it
    external_reference: Mapped[str | None] = mapped_column(String(120))


class PaytmPayment(UUIDPk, MerchantScoped, Timestamps, Base):
    """One attempt to collect an open bill (cart) through Paytm, kept for reconciliation.

    The cart stays open and no stock moves while this is pending. Only when the backend has
    fetched TXN_SUCCESS from Paytm for `paytm_order_id` is the bill completed (orders.checkout),
    which creates the Order and the Payment this row then points to. No credentials are stored.
    """

    __tablename__ = "paytm_payments"
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("discount >= 0", name="discount_non_negative"),
        enum_check("status", PaytmPaymentStatus),
        # At most one attempt per bill may be in flight or holding received money.
        Index(
            "uq_paytm_payments_cart_id_live",
            "cart_id",
            unique=True,
            postgresql_where=text("status IN ('pending', 'needs_review')"),
        ),
    )

    cart_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("carts.id", ondelete="SET NULL"), index=True)
    order_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("orders.id"), unique=True)  # set once paid
    payment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("payments.id"))  # the money record, once paid
    paytm_order_id: Mapped[str] = mapped_column(String(50), unique=True)  # the orderId sent to Paytm
    environment: Mapped[str] = mapped_column(String(20))  # sandbox | production
    amount: Mapped[Decimal]  # the bill total when the attempt started, computed by the backend
    discount: Mapped[Decimal] = mapped_column(default=Decimal(0))
    status: Mapped[str] = mapped_column(String(20), default=PaytmPaymentStatus.PENDING)
    # What Paytm reported (Transaction Status API):
    txn_id: Mapped[str | None] = mapped_column(String(64))
    bank_txn_id: Mapped[str | None] = mapped_column(String(64))
    payment_mode: Mapped[str | None] = mapped_column(String(20))
    result_code: Mapped[str | None] = mapped_column(String(64))
    result_msg: Mapped[str | None] = mapped_column(String(255))
    detail: Mapped[str | None] = mapped_column(String(255))  # why it needs review, in the merchant's words
    verified_at: Mapped[datetime | None]  # when Paytm confirmed the money
