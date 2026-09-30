from sqlalchemy import String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, MerchantScoped, Timestamps, UUIDPk


class Customer(UUIDPk, MerchantScoped, Timestamps, Base):
    __tablename__ = "customers"
    __table_args__ = (UniqueConstraint("merchant_id", "phone"),)

    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(20))
