import uuid

from fastapi import APIRouter, status

from app.core.db import DbSession
from app.modules.auth.deps import Tenant
from app.modules.customers import service
from app.modules.customers.schemas import CustomerCreate, CustomerRead, CustomerUpdate

router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("")
def list_customers(db: DbSession, ctx: Tenant, q: str | None = None) -> list[CustomerRead]:
    return service.list_customers(db, ctx, q=q)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_customer(data: CustomerCreate, db: DbSession, ctx: Tenant) -> CustomerRead:
    customer = service.create_customer(db, ctx, data)
    db.commit()
    return customer


@router.get("/{customer_id}")
def get_customer(customer_id: uuid.UUID, db: DbSession, ctx: Tenant) -> CustomerRead:
    return service.get_customer(db, ctx, customer_id)


@router.patch("/{customer_id}")
def update_customer(customer_id: uuid.UUID, data: CustomerUpdate, db: DbSession, ctx: Tenant) -> CustomerRead:
    customer = service.update_customer(db, ctx, customer_id, data)
    db.commit()
    return customer


@router.delete("/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(customer_id: uuid.UUID, db: DbSession, ctx: Tenant) -> None:
    service.delete_customer(db, ctx, customer_id)
    db.commit()
