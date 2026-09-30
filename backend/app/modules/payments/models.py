import uuid
from decimal import Decimal

from sqlalchemy import CheckConstraint, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, CreatedAt, MerchantScoped, UUIDPk
from app.core.enums import PaymentMethod, PaymentRecordStatus, enum_check


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
