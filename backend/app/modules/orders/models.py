import uuid
from decimal import Decimal

from sqlalchemy import CheckConstraint, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import QUANTITY, Base, CreatedAt, MerchantScoped, Timestamps, UUIDPk
from app.core.enums import Channel, InputSource, OrderStatus, PaymentStatus, enum_check
from app.core.tax import TaxSummary, summarize


class Order(UUIDPk, MerchantScoped, Timestamps, Base):
    __tablename__ = "orders"
    __table_args__ = (
        enum_check("channel", Channel),
        enum_check("status", OrderStatus),
        enum_check("payment_status", PaymentStatus),
        CheckConstraint("subtotal >= 0", name="subtotal_non_negative"),
        CheckConstraint("discount >= 0 AND discount <= subtotal", name="discount_valid"),
        CheckConstraint("total = subtotal - discount", name="total_consistent"),
    )

    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("customers.id"), index=True)
    cart_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("carts.id", ondelete="SET NULL"), unique=True)
    # Contact a Shop customer gave when ordering without an account (not a khata customer).
    customer_name: Mapped[str | None] = mapped_column(String(120))
    customer_phone: Mapped[str | None] = mapped_column(String(20))
    channel: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default=OrderStatus.PENDING)
    subtotal: Mapped[Decimal]
    discount: Mapped[Decimal] = mapped_column(default=Decimal(0))
    total: Mapped[Decimal]
    payment_status: Mapped[str] = mapped_column(String(20), default=PaymentStatus.UNPAID)

    items: Mapped[list["OrderItem"]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="OrderItem.created_at"
    )

    @property
    def tax_summary(self) -> TaxSummary:
        return summarize([(item.line_total, item.tax_rate) for item in self.items])


class OrderItem(UUIDPk, CreatedAt, Base):
    __tablename__ = "order_items"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("unit_price >= 0", name="unit_price_non_negative"),
        enum_check("source", InputSource),
    )

    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"))
    product_name: Mapped[str] = mapped_column(String(160))  # snapshot for historical bills
    quantity: Mapped[Decimal] = mapped_column(QUANTITY)
    unit_price: Mapped[Decimal]
    tax_rate: Mapped[Decimal] = mapped_column(default=Decimal(0))  # snapshot, like product_name
    source: Mapped[str] = mapped_column(String(20), default=InputSource.MANUAL)

    order: Mapped[Order] = relationship(back_populates="items")

    @property
    def line_total(self) -> Decimal:
        return (self.quantity * self.unit_price).quantize(Decimal("0.01"))
