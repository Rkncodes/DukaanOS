import uuid

from fastapi import APIRouter, Query

from app.core.db import DbSession
from app.modules.auth.deps import Tenant
from app.modules.orders import service
from app.modules.orders.schemas import BillRead, OrderRead

router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("")
def list_orders(
    db: DbSession,
    ctx: Tenant,
    customer_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> list[OrderRead]:
    return service.list_orders(db, ctx, customer_id=customer_id, limit=limit)


@router.get("/{order_id}")
def get_order(order_id: uuid.UUID, db: DbSession, ctx: Tenant) -> OrderRead:
    return service.get_order(db, ctx, order_id)


@router.get("/{order_id}/bill")
def get_bill(order_id: uuid.UUID, db: DbSession, ctx: Tenant) -> BillRead:
    return service.get_bill(db, ctx, order_id)
