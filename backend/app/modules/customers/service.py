import uuid

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.tenancy import TenantContext, get_owned, scoped
from app.modules.customers.models import Customer
from app.modules.customers.schemas import CustomerCreate, CustomerUpdate


def list_customers(db: Session, ctx: TenantContext, *, q: str | None = None) -> list[Customer]:
    stmt = scoped(Customer, ctx).order_by(Customer.name)
    if q:
        stmt = stmt.where(or_(Customer.name.ilike(f"%{q}%"), Customer.phone.ilike(f"%{q}%")))
    return list(db.scalars(stmt))


def get_customer(db: Session, ctx: TenantContext, customer_id: uuid.UUID) -> Customer:
    return get_owned(db, Customer, customer_id, ctx)


def create_customer(db: Session, ctx: TenantContext, data: CustomerCreate) -> Customer:
    customer = Customer(merchant_id=ctx.merchant_id, **data.model_dump())
    db.add(customer)
    db.flush()
    return customer


def update_customer(db: Session, ctx: TenantContext, customer_id: uuid.UUID, data: CustomerUpdate) -> Customer:
    customer = get_owned(db, Customer, customer_id, ctx)
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(customer, field, value)
    db.flush()
    return customer


def delete_customer(db: Session, ctx: TenantContext, customer_id: uuid.UUID) -> None:
    """Fails with 409 (FK) if the customer has khata entries, orders or payments."""
    db.delete(get_owned(db, Customer, customer_id, ctx))
    db.flush()
