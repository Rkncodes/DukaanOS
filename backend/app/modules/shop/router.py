import uuid

from fastapi import APIRouter, status

from app.core.db import DbSession
from app.modules.shop import service
from app.modules.shop.schemas import StoreOrderCreate, StoreOrderRead, StoreProduct, StoreRead

# Public: no login. The store in the URL is the only merchant these routes can reach.
router = APIRouter(prefix="/public/stores/{store_slug}", tags=["shop"])


@router.get("")
def get_store(store_slug: str, db: DbSession) -> StoreRead:
    return service.get_store(db, store_slug)


@router.get("/products")
def list_products(
    store_slug: str, db: DbSession, q: str | None = None, category_id: uuid.UUID | None = None
) -> list[StoreProduct]:
    return service.list_products(db, store_slug, q=q, category_id=category_id)


@router.post("/orders", status_code=status.HTTP_201_CREATED)
def place_order(store_slug: str, data: StoreOrderCreate, db: DbSession) -> StoreOrderRead:
    """Place an order with this store. Prices, totals and stock are decided by the backend.
    The order is pending and unpaid until the merchant accepts and hands it over."""
    order = service.place_order(db, store_slug, data)
    db.commit()
    return order


@router.get("/orders/{order_id}")
def get_order(store_slug: str, order_id: uuid.UUID, db: DbSession) -> StoreOrderRead:
    return service.get_order(db, store_slug, order_id)
