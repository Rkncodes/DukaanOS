import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import (
    CartStatus,
    Channel,
    CheckoutMethod,
    OrderStatus,
    PaymentMethod,
    PaymentRecordStatus,
    PaymentStatus,
)
from app.core.errors import Conflict, DomainValidationError
from app.core.tenancy import TenantContext, get_owned, scoped
from app.modules.billing import service as billing
from app.modules.billing.models import Cart
from app.modules.billing.schemas import CheckoutRequest
from app.modules.customers import service as customers
from app.modules.customers.schemas import CustomerRead
from app.modules.inventory import service as inventory
from app.modules.khata import service as khata
from app.modules.khata.schemas import KhataEntryRead
from app.modules.orders.models import Order, OrderItem
from app.modules.orders.schemas import BillRead, OrderRead
from app.modules.payments import service as payments
from app.modules.payments.models import Payment
from app.modules.payments.schemas import PaymentRead


# The only moves an order may make. A Counter bill is completed at checkout and never moves again.
TRANSITIONS: dict[str, tuple[OrderStatus, ...]] = {
    OrderStatus.PENDING: (OrderStatus.CONFIRMED, OrderStatus.CANCELLED),
    OrderStatus.CONFIRMED: (OrderStatus.READY, OrderStatus.CANCELLED),
    OrderStatus.READY: (OrderStatus.COMPLETED, OrderStatus.CANCELLED),
}


def _order_from_cart(db: Session, ctx: TenantContext, cart: Cart, discount: Decimal) -> Order:
    """The one place a cart becomes an order (Counter and Shop): stock is taken, lines are
    snapshotted at the cart's prices. The order starts pending and unpaid; the caller settles it."""
    subtotal = cart.subtotal
    order = Order(
        merchant_id=ctx.merchant_id,
        customer_id=cart.customer_id,
        cart_id=cart.id,
        channel=cart.channel,
        status=OrderStatus.PENDING,
        subtotal=subtotal,
        discount=discount,
        total=subtotal - discount,
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
    return order


def checkout(
    db: Session, ctx: TenantContext, cart_id: uuid.UUID, data: CheckoutRequest, *, received: Payment | None = None
) -> Order:
    """Cart -> Order, atomically (caller commits):
    decrement stock, then either record a Payment or put the total on the customer's khata.

    `received` is money a gateway has already verified for exactly this bill (payments.paytm).
    It settles the bill in place of `data.method`, so nothing is collected a second time."""
    cart = billing.get_open_cart(db, ctx, cart_id)
    if not cart.items:
        raise DomainValidationError("Cart is empty")
    if data.method == CheckoutMethod.KHATA and cart.customer_id is None:
        raise DomainValidationError("Select a customer to put this bill on khata")

    subtotal = cart.subtotal
    if data.discount > subtotal:
        raise DomainValidationError("Discount cannot exceed subtotal")
    total = subtotal - data.discount
    if received is not None and received.amount != total:
        raise Conflict(f"The bill is {total} but the payment received is {received.amount}")

    order = _order_from_cart(db, ctx, cart, data.discount)

    if total == 0:
        order.payment_status = PaymentStatus.PAID
    elif received is not None:
        received.order_id = order.id
        db.add(received)
        if received.status == PaymentRecordStatus.SUCCEEDED:
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


def place_order(
    db: Session,
    ctx: TenantContext,
    cart_id: uuid.UUID,
    *,
    customer_name: str | None = None,
    customer_phone: str | None = None,
) -> Order:
    """Cart -> Order that the merchant still has to accept (Shop), atomically (caller commits).
    Stock is taken now, so nothing can be oversold; no money is recorded: the order stays
    pending and unpaid until the merchant moves it (set_status)."""
    cart = billing.get_open_cart(db, ctx, cart_id)
    if not cart.items:
        raise DomainValidationError("Cart is empty")
    order = _order_from_cart(db, ctx, cart, Decimal(0))
    order.customer_name = customer_name
    order.customer_phone = customer_phone
    cart.status = CartStatus.CHECKED_OUT
    db.flush()
    return order


def set_status(
    db: Session,
    ctx: TenantContext,
    order_id: uuid.UUID,
    status: OrderStatus,
    *,
    payment_method: PaymentMethod | None = None,
) -> Order:
    """Move this merchant's order one valid step (TRANSITIONS). Cancelling returns its stock;
    completing an unpaid order records how the customer paid. Caller commits."""
    order = get_owned(db, Order, order_id, ctx, for_update=True)
    if status not in TRANSITIONS.get(order.status, ()):
        raise Conflict(f"An order that is {order.status} cannot become {status}")

    if status == OrderStatus.CANCELLED:
        if order.payment_status != PaymentStatus.UNPAID:
            raise Conflict("This order is already paid for. It cannot be cancelled here.")
        for item in sorted(order.items, key=lambda i: str(i.product_id)):
            inventory.adjust_stock(db, ctx, item.product_id, item.quantity)  # back on the shelf
    elif status == OrderStatus.COMPLETED and order.payment_status == PaymentStatus.UNPAID:
        if order.total == 0:
            order.payment_status = PaymentStatus.PAID
        elif payment_method is None:
            raise DomainValidationError("Choose how the customer paid to complete this order")
        else:
            payment = payments.record_payment(
                db, ctx, amount=order.total, method=payment_method, order_id=order.id, customer_id=order.customer_id
            )
            if payment.status != PaymentRecordStatus.SUCCEEDED:
                raise Conflict("The payment was not received, so the order is not completed")
            order.payment_status = PaymentStatus.PAID
    order.status = status
    db.flush()
    return order


def list_orders(
    db: Session,
    ctx: TenantContext,
    *,
    customer_id: uuid.UUID | None = None,
    channel: Channel | None = None,
    status: OrderStatus | None = None,
    since: datetime | None = None,
    limit: int | None = 50,
) -> list[Order]:
    """Newest first. `since` keeps orders created at or after that moment; limit=None reads them all."""
    stmt = scoped(Order, ctx).order_by(Order.created_at.desc())
    if limit is not None:
        stmt = stmt.limit(limit)
    if since is not None:
        stmt = stmt.where(Order.created_at >= since)
    if customer_id is not None:
        stmt = stmt.where(Order.customer_id == customer_id)
    if channel is not None:
        stmt = stmt.where(Order.channel == channel)
    if status is not None:
        stmt = stmt.where(Order.status == status)
    return list(db.scalars(stmt))


def get_order(db: Session, ctx: TenantContext, order_id: uuid.UUID) -> Order:
    return get_owned(db, Order, order_id, ctx)


def get_bill(db: Session, ctx: TenantContext, order_id: uuid.UUID) -> BillRead:
    order = get_order(db, ctx, order_id)
    customer = customers.get_customer(db, ctx, order.customer_id) if order.customer_id else None
    khata_entry = khata.credit_for_order(db, ctx, order.id)
    return BillRead(
        order=OrderRead.model_validate(order),
        customer=CustomerRead.model_validate(customer) if customer else None,
        payments=[PaymentRead.model_validate(p) for p in payments.list_for_order(db, ctx, order.id)],
        khata_entry=KhataEntryRead.model_validate(khata_entry) if khata_entry else None,
        customer_balance=khata.get_balance(db, ctx, customer.id) if customer else None,
    )
