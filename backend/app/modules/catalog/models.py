import uuid
from decimal import Decimal

from sqlalchemy import CheckConstraint, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import QUANTITY, Base, CreatedAt, MerchantScoped, Timestamps, UUIDPk


class Category(UUIDPk, MerchantScoped, CreatedAt, Base):
    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("merchant_id", "name"),)

    name: Mapped[str] = mapped_column(String(80))


class Product(UUIDPk, MerchantScoped, Timestamps, Base):
    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("merchant_id", "sku"),
        UniqueConstraint("merchant_id", "barcode"),
        CheckConstraint("price >= 0", name="price_non_negative"),
        CheckConstraint("cost_price IS NULL OR cost_price >= 0", name="cost_price_non_negative"),
        CheckConstraint("stock_quantity >= 0", name="stock_non_negative"),
    )

    category_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(160))
    sku: Mapped[str | None] = mapped_column(String(64))
    barcode: Mapped[str | None] = mapped_column(String(64))
    price: Mapped[Decimal]
    cost_price: Mapped[Decimal | None]
    # Only mutated through app.modules.inventory.service after creation.
    stock_quantity: Mapped[Decimal] = mapped_column(QUANTITY, default=Decimal(0))
    unit: Mapped[str] = mapped_column(String(16), default="pcs")
    image_url: Mapped[str | None] = mapped_column(String(500))
    is_active: Mapped[bool] = mapped_column(default=True)

    category: Mapped[Category | None] = relationship()
