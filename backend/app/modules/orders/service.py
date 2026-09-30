import uuid

from sqlalchemy.orm import Session

from app.core.enums import (
    CartStatus,
    CheckoutMethod,
    OrderStatus,
    PaymentMethod,
    PaymentRecordStatus,
    PaymentStatus,
)
from app.core.errors import DomainValidationError
from app.core.tenancy import TenantContext, get_owned, scoped
from app.modules.billing import service as billing
from app.modules.billing.schemas import CheckoutRequest
from app.modules.inventory import service as inventory
from app.modules.khata import service as khata
from app.modules.orders.models import Order, OrderItem
from app.modules.payments import service as payments


def checkout(db: Session, ctx: TenantContext, cart_id: uuid.UUID, data: CheckoutRequest) -> Order:
    """Cart -> Order, atomically (caller commits):
    decrement stock, then either record a Payment or put the total on the customer's khata."""
    cart = billing.get_open_cart(db, ctx, cart_id)
    if not cart.items:
        raise DomainValidationError("Cart is empty")
    if data.method == CheckoutMethod.KHATA and cart.customer_id is None:
        raise DomainValidationError("Select a customer to put this bill on khata")

    subtotal = cart.subtotal
    if data.discount > subtotal:
        raise DomainValidationError("Discount cannot exceed subtotal")
    total = subtotal - data.discount

    order = Order(
        merchant_id=ctx.merchant_id,
        customer_id=cart.customer_id,
        cart_id=cart.id,
        channel=cart.channel,
        status=OrderStatus.PENDING,
        subtotal=subtotal,
        discount=data.discount,
        total=total,
        payment_status=PaymentStatus.UNPAID,
    )
    # Lock products in a stable order to avoid deadlocks between concurrent checkouts.
    for item in sorted(cart.items, key=lambda i: str(i.product_id)):
        inventory.decrement_for_sale(db, ctx, item.product_id, item.quantity)
    for item in cart.items:
        order.items.append(
            OrderItem(
                product_id=item.product_id,
                product_name=item.product.name,
                quantity=item.quantity,
                unit_price=item.unit_price,
                source=item.source,
            )
        )
    db.add(order)
    db.flush()

    if total == 0:
        order.payment_status = PaymentStatus.PAID
    elif data.method == CheckoutMethod.KHATA:
        assert cart.customer_id is not None
        khata.add_credit(
            db, ctx, cart.customer_id, total, description=f"Bill {str(order.id)[:8]}", order_id=order.id
        )
        order.payment_status = PaymentStatus.CREDIT
    else:
        payment = payments.record_payment(
            db,
            ctx,
            amount=total,
            method=PaymentMethod(data.method),
            order_id=order.id,
            customer_id=cart.customer_id,
        )
        if payment.status == PaymentRecordStatus.SUCCEEDED:
            order.payment_status = PaymentStatus.PAID

    if order.payment_status != PaymentStatus.UNPAID:
        order.status = OrderStatus.COMPLETED
    cart.status = CartStatus.CHECKED_OUT
    db.flush()
    return order


def list_orders(
    db: Session, ctx: TenantContext, *, customer_id: uuid.UUID | None = None, limit: int = 50
) -> list[Order]:
    stmt = scoped(Order, ctx).order_by(Order.created_at.desc()).limit(limit)
    if customer_id is not None:
        stmt = stmt.where(Order.customer_id == customer_id)
    return list(db.scalars(stmt))


def get_order(db: Session, ctx: TenantContext, order_id: uuid.UUID) -> Order:
    return get_owned(db, Order, order_id, ctx)
