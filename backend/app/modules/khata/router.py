import uuid

from fastapi import APIRouter, status

from app.core.db import DbSession
from app.modules.auth.deps import Tenant
from app.modules.customers import service as customers
from app.modules.customers.schemas import CustomerRead
from app.modules.khata import service
from app.modules.khata.schemas import (
    CustomerLedger,
    KhataBalance,
    KhataCreditCreate,
    KhataEntryRead,
    KhataPaymentCreate,
)

router = APIRouter(tags=["khata"])


@router.get("/khata/balances")
def list_balances(db: DbSession, ctx: Tenant, outstanding_only: bool = False) -> list[KhataBalance]:
    return service.list_balances(db, ctx, outstanding_only=outstanding_only)


@router.get("/customers/{customer_id}/khata")
def get_ledger(customer_id: uuid.UUID, db: DbSession, ctx: Tenant) -> CustomerLedger:
    return CustomerLedger(
        customer=CustomerRead.model_validate(customers.get_customer(db, ctx, customer_id)),
        balance=service.get_balance(db, ctx, customer_id),
        entries=[KhataEntryRead.model_validate(e) for e in service.list_entries(db, ctx, customer_id)],
    )


@router.post("/customers/{customer_id}/khata/credits", status_code=status.HTTP_201_CREATED)
def add_credit(customer_id: uuid.UUID, data: KhataCreditCreate, db: DbSession, ctx: Tenant) -> KhataEntryRead:
    entry = service.add_credit(
        db, ctx, customer_id, data.amount, description=data.description, source=data.source
    )
    db.commit()
    return entry


@router.post("/customers/{customer_id}/khata/payments", status_code=status.HTTP_201_CREATED)
def record_payment(
    customer_id: uuid.UUID, data: KhataPaymentCreate, db: DbSession, ctx: Tenant
) -> KhataEntryRead:
    entry = service.record_payment(
        db,
        ctx,
        customer_id,
        data.amount,
        method=data.method,
        description=data.description,
        source=data.source,
    )
    db.commit()
    return entry
