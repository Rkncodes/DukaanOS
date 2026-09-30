import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, Timestamps, UUIDPk
from app.core.enums import UserRole, enum_check


class Merchant(UUIDPk, Timestamps, Base):
    __tablename__ = "merchants"

    name: Mapped[str] = mapped_column(String(120))  # owner / business name
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(20))
    store_name: Mapped[str] = mapped_column(String(120))
    store_slug: Mapped[str] = mapped_column(String(80), unique=True)  # public Shop URL / QR

    users: Mapped[list["User"]] = relationship(back_populates="merchant")


class User(UUIDPk, Timestamps, Base):
    __tablename__ = "users"
    __table_args__ = (enum_check("role", UserRole),)

    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), unique=True)  # stored lower-cased
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default=UserRole.OWNER)

    merchant: Mapped[Merchant] = relationship(back_populates="users")
