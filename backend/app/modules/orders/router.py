import uuid

from fastapi import APIRouter, Query

from app.core.db import DbSession
from app.core.enums import Channel, OrderStatus
from app.modules.auth.deps import Tenant
from app.modules.orders import service
from app.modules.orders.schemas import BillRead, OrderRead, OrderStatusUpdate

router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("")
def list_orders(
    db: DbSession,
    ctx: Tenant,
    customer_id: uuid.UUID | None = None,
    channel: Channel | None = None,
    status: OrderStatus | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> list[OrderRead]:
    return service.list_orders(db, ctx, customer_id=customer_id, channel=channel, status=status, limit=limit)


@router.get("/{order_id}")
def get_order(order_id: uuid.UUID, db: DbSession, ctx: Tenant) -> OrderRead:
    return service.get_order(db, ctx, order_id)


@router.get("/{order_id}/bill")
def get_bill(order_id: uuid.UUID, db: DbSession, ctx: Tenant) -> BillRead:
    return service.get_bill(db, ctx, order_id)


@router.patch("/{order_id}/status")
def set_status(order_id: uuid.UUID, data: OrderStatusUpdate, db: DbSession, ctx: Tenant) -> OrderRead:
    """Accept, ready, complete or cancel an order. Only the next valid step is allowed (409 otherwise)."""
    order = service.set_status(db, ctx, order_id, data.status, payment_method=data.payment_method)
    db.commit()
    return order
