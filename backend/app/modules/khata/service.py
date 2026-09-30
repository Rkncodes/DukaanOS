import uuid
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.enums import InputSource, KhataEntryType, PaymentMethod
from app.core.errors import DomainValidationError
from app.core.tenancy import TenantContext, get_owned, scoped
from app.modules.customers.models import Customer
from app.modules.khata.models import KhataEntry
from app.modules.khata.schemas import KhataBalance
from app.modules.payments import service as payments

_signed_amount = case(
    (KhataEntry.type == KhataEntryType.CREDIT, KhataEntry.amount),
    else_=-KhataEntry.amount,
)


def add_credit(
    db: Session,
    ctx: TenantContext,
    customer_id: uuid.UUID,
    amount: Decimal,
    *,
    description: str | None = None,
    order_id: uuid.UUID | None = None,
    source: InputSource = InputSource.MANUAL,
) -> KhataEntry:
    """Udhaar given (customer owes more). order_id is set when a sale was put on khata."""
    if amount <= 0:
        raise DomainValidationError("Amount must be positive")
    get_owned(db, Customer, customer_id, ctx)
    entry = KhataEntry(
        merchant_id=ctx.merchant_id,
        customer_id=customer_id,
        type=KhataEntryType.CREDIT,
        amount=amount,
        description=description,
        order_id=order_id,
        source=source,
    )
    db.add(entry)
    db.flush()
    return entry


def record_payment(
    db: Session,
    ctx: TenantContext,
    customer_id: uuid.UUID,
    amount: Decimal,
    *,
    method: PaymentMethod = PaymentMethod.CASH,
    description: str | None = None,
    source: InputSource = InputSource.MANUAL,
) -> KhataEntry:
    """Customer pays back udhaar: records real money (Payment) + ledger entry.
    Paying more than the balance is allowed and shows as advance (negative balance)."""
    get_owned(db, Customer, customer_id, ctx)
    payment = payments.record_payment(db, ctx, amount=amount, method=method, customer_id=customer_id)
    entry = KhataEntry(
        merchant_id=ctx.merchant_id,
        customer_id=customer_id,
        type=KhataEntryType.PAYMENT,
        amount=amount,
        description=description,
        payment_id=payment.id,
        source=source,
    )
    db.add(entry)
    db.flush()
    return entry


def list_entries(db: Session, ctx: TenantContext, customer_id: uuid.UUID) -> list[KhataEntry]:
    get_owned(db, Customer, customer_id, ctx)
    stmt = (
        scoped(KhataEntry, ctx)
        .where(KhataEntry.customer_id == customer_id)
        .order_by(KhataEntry.created_at.desc(), KhataEntry.id)
    )
    return list(db.scalars(stmt))


def credit_for_order(db: Session, ctx: TenantContext, order_id: uuid.UUID) -> KhataEntry | None:
    """The udhaar entry created when a sale was put on khata, if any."""
    stmt = scoped(KhataEntry, ctx).where(
        KhataEntry.order_id == order_id, KhataEntry.type == KhataEntryType.CREDIT
    )
    return db.scalars(stmt).first()


def get_balance(db: Session, ctx: TenantContext, customer_id: uuid.UUID) -> Decimal:
    get_owned(db, Customer, customer_id, ctx)
    total = db.scalar(
        select(func.coalesce(func.sum(_signed_amount), 0)).where(
            KhataEntry.merchant_id == ctx.merchant_id, KhataEntry.customer_id == customer_id
        )
    )
    return Decimal(total).quantize(Decimal("0.01"))


def list_balances(db: Session, ctx: TenantContext, *, outstanding_only: bool = False) -> list[KhataBalance]:
    balance = func.coalesce(func.sum(_signed_amount), 0)
    stmt = (
        select(Customer.id, Customer.name, Customer.phone, balance, func.max(KhataEntry.created_at))
        .outerjoin(
            KhataEntry,
            (KhataEntry.customer_id == Customer.id) & (KhataEntry.merchant_id == ctx.merchant_id),
        )
        .where(Customer.merchant_id == ctx.merchant_id)
        .group_by(Customer.id)
        .order_by(balance.desc(), Customer.name)
    )
    if outstanding_only:
        stmt = stmt.having(balance > 0)
    return [
        KhataBalance(
            customer_id=cid,
            customer_name=name,
            phone=phone,
            balance=Decimal(bal).quantize(Decimal("0.01")),
            last_entry_at=last,
        )
        for cid, name, phone, bal, last in db.execute(stmt)
    ]
