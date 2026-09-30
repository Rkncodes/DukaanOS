import uuid
from decimal import Decimal

from sqlalchemy import CheckConstraint, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import QUANTITY, Base, CreatedAt, MerchantScoped, Timestamps, UUIDPk
from app.core.enums import CartStatus, Channel, InputSource, enum_check
from app.modules.catalog.models import Product


class Cart(UUIDPk, MerchantScoped, Timestamps, Base):
    __tablename__ = "carts"
    __table_args__ = (enum_check("status", CartStatus), enum_check("channel", Channel))

    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("customers.id"))
    channel: Mapped[str] = mapped_column(String(20), default=Channel.COUNTER)
    status: Mapped[str] = mapped_column(String(20), default=CartStatus.OPEN)

    items: Mapped[list["CartItem"]] = relationship(
        back_populates="cart", cascade="all, delete-orphan", order_by="CartItem.created_at"
    )

    @property
    def subtotal(self) -> Decimal:
        return sum((item.line_total for item in self.items), Decimal("0.00"))


class CartItem(UUIDPk, CreatedAt, Base):
    __tablename__ = "cart_items"
    __table_args__ = (
        UniqueConstraint("cart_id", "product_id"),  # re-adding a product increments quantity
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("unit_price >= 0", name="unit_price_non_negative"),
        enum_check("source", InputSource),
    )

    cart_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("carts.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Decimal] = mapped_column(QUANTITY)
    unit_price: Mapped[Decimal]  # price snapshot when added
    source: Mapped[str] = mapped_column(String(20), default=InputSource.MANUAL)

    cart: Mapped[Cart] = relationship(back_populates="items")
    product: Mapped[Product] = relationship()

    @property
    def product_name(self) -> str:
        return self.product.name

    @property
    def line_total(self) -> Decimal:
        return (self.quantity * self.unit_price).quantize(Decimal("0.01"))
