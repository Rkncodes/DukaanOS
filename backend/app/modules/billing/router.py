import uuid

from fastapi import APIRouter, status

from app.core.db import DbSession
from app.integrations.types import RecognizedItem
from app.modules.auth.deps import Tenant
from app.modules.billing import service
from app.modules.billing.schemas import (
    CartCreate,
    CartItemAdd,
    CartItemUpdate,
    CartRead,
    CartUpdate,
    CheckoutRequest,
    ConfirmedItemsAdd,
)
from app.modules.orders import service as orders
from app.modules.orders.schemas import OrderRead

router = APIRouter(prefix="/carts", tags=["billing"])


@router.post("", status_code=status.HTTP_201_CREATED)
def create_cart(data: CartCreate, db: DbSession, ctx: Tenant) -> CartRead:
    cart = service.create_cart(db, ctx, data)
    db.commit()
    return cart


@router.get("/{cart_id}")
def get_cart(cart_id: uuid.UUID, db: DbSession, ctx: Tenant) -> CartRead:
    return service.get_cart(db, ctx, cart_id)


@router.patch("/{cart_id}")
def update_cart(cart_id: uuid.UUID, data: CartUpdate, db: DbSession, ctx: Tenant) -> CartRead:
    cart = service.set_customer(db, ctx, cart_id, data.customer_id)
    db.commit()
    return cart


@router.post("/{cart_id}/items")
def add_item(cart_id: uuid.UUID, data: CartItemAdd, db: DbSession, ctx: Tenant) -> CartRead:
    if data.barcode is not None:
        cart = service.add_item_by_barcode(db, ctx, cart_id, data.barcode, data.quantity, data.source)
    else:
        assert data.product_id is not None
        cart = service.add_item(db, ctx, cart_id, data.product_id, data.quantity, data.source)
    db.commit()
    return cart


@router.post("/{cart_id}/recognized-items")
def add_confirmed_items(cart_id: uuid.UUID, data: ConfirmedItemsAdd, db: DbSession, ctx: Tenant) -> CartRead:
    items = [RecognizedItem(source=data.source, product_id=i.product_id, quantity=i.quantity) for i in data.items]
    cart = service.add_confirmed_items(db, ctx, cart_id, items)
    db.commit()
    return cart


@router.patch("/{cart_id}/items/{item_id}")
def update_item(
    cart_id: uuid.UUID, item_id: uuid.UUID, data: CartItemUpdate, db: DbSession, ctx: Tenant
) -> CartRead:
    cart = service.update_item_quantity(db, ctx, cart_id, item_id, data.quantity)
    db.commit()
    return cart


@router.delete("/{cart_id}/items/{item_id}")
def remove_item(cart_id: uuid.UUID, item_id: uuid.UUID, db: DbSession, ctx: Tenant) -> CartRead:
    cart = service.remove_item(db, ctx, cart_id, item_id)
    db.commit()
    return cart


@router.post("/{cart_id}/checkout", status_code=status.HTTP_201_CREATED)
def checkout(cart_id: uuid.UUID, data: CheckoutRequest, db: DbSession, ctx: Tenant) -> OrderRead:
    order = orders.checkout(db, ctx, cart_id, data)
    db.commit()
    return order
