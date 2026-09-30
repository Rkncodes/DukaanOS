import uuid
from decimal import Decimal

from sqlalchemy import CheckConstraint, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, CreatedAt, MerchantScoped, UUIDPk
from app.core.enums import InputSource, KhataEntryType, enum_check


class KhataEntry(UUIDPk, MerchantScoped, CreatedAt, Base):
    """Append-only ledger. Balance = sum(credit) - sum(payment), always computed."""

    __tablename__ = "khata_entries"
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("type <> 'payment' OR payment_id IS NOT NULL", name="payment_has_payment_id"),
        enum_check("type", KhataEntryType),
        enum_check("source", InputSource),
    )

    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customers.id"), index=True)
    type: Mapped[str] = mapped_column(String(20))
    amount: Mapped[Decimal]
    description: Mapped[str | None] = mapped_column(String(255))
    order_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("orders.id"))
    payment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("payments.id"), unique=True)
    source: Mapped[str] = mapped_column(String(20), default=InputSource.MANUAL)
