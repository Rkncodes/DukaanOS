import uuid
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import PaymentMethod
from app.core.errors import DomainValidationError
from app.core.tenancy import TenantContext, get_owned, scoped
from app.modules.customers.models import Customer
from app.modules.orders.models import Order
from app.modules.payments.models import Payment
from app.modules.payments.providers import get_provider


def record_payment(
    db: Session,
    ctx: TenantContext,
    *,
    amount: Decimal,
    method: PaymentMethod,
    order_id: uuid.UUID | None = None,
    customer_id: uuid.UUID | None = None,
) -> Payment:
    if amount <= 0:
        raise DomainValidationError("Payment amount must be positive")
    if order_id is not None:
        get_owned(db, Order, order_id, ctx)
    if customer_id is not None:
        get_owned(db, Customer, customer_id, ctx)

    provider = get_provider(PaymentMethod(method))
    result = provider.collect(amount=amount, method=method, reference=str(order_id or customer_id or ""))
    payment = Payment(
        merchant_id=ctx.merchant_id,
        order_id=order_id,
        customer_id=customer_id,
        amount=amount,
        method=method,
        status=result.status,
        provider=provider.name,
        external_reference=result.external_reference,
    )
    db.add(payment)
    db.flush()
    return payment


def list_for_order(db: Session, ctx: TenantContext, order_id: uuid.UUID) -> list[Payment]:
    stmt = scoped(Payment, ctx).where(Payment.order_id == order_id).order_by(Payment.created_at)
    return list(db.scalars(stmt))
