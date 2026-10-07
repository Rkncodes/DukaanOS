"""The public storefront: one merchant's catalogue and order placement, without a login.

The merchant comes from the slug in the URL and from nowhere else; everything after that goes
through the same tenant-scoped services as the Counter (catalog, billing, inventory, orders),
with channel = shop. Prices and totals are always the database's.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import Channel
from app.core.errors import NotFound
from app.core.tenancy import TenantContext, scoped
from app.modules.billing import service as billing
from app.modules.billing.schemas import CartCreate
from app.modules.catalog import service as catalog
from app.modules.catalog.models import Product
from app.modules.merchants.models import Merchant
from app.modules.orders import service as orders
from app.modules.orders.models import Order
from app.modules.shop.schemas import StoreOrderCreate, StoreProduct, StoreRead


def get_merchant(db: Session, store_slug: str) -> Merchant:
    merchant = db.scalars(select(Merchant).where(Merchant.store_slug == store_slug)).one_or_none()
    if merchant is None:
        raise NotFound("Store not found")
    return merchant


def _context(merchant: Merchant) -> TenantContext:
    return TenantContext(merchant_id=merchant.id)  # no user: the customer is not logged in


def _public(product: Product) -> StoreProduct:
    return StoreProduct(
        id=product.id,
        name=product.name,
        price=product.price,
        unit=product.unit,
        image_url=product.image_url,
        category_id=product.category_id,
        in_stock=product.stock_quantity > 0,
    )


def get_store(db: Session, store_slug: str) -> StoreRead:
    merchant = get_merchant(db, store_slug)
    ctx = _context(merchant)
    on_sale = {p.category_id for p in catalog.list_products(db, ctx)}
    return StoreRead(
        store_name=merchant.store_name,
        store_slug=merchant.store_slug,
        categories=[c for c in catalog.list_categories(db, ctx) if c.id in on_sale],
    )


def list_products(
    db: Session, store_slug: str, *, q: str | None = None, category_id: uuid.UUID | None = None
) -> list[StoreProduct]:
    """This merchant's active products only."""
    ctx = _context(get_merchant(db, store_slug))
    return [_public(p) for p in catalog.list_products(db, ctx, q=q, category_id=category_id)]


def place_order(db: Session, store_slug: str, data: StoreOrderCreate) -> Order:
    """A customer's order, built the way a Counter bill is: cart -> order (caller commits).
    Every product is re-read from this merchant's catalogue, so prices are the catalogue's and
    products of another store, or switched off, are refused. Stock is checked and taken in the
    same transaction; if any line fails, nothing is ordered."""
    ctx = _context(get_merchant(db, store_slug))
    cart = billing.create_cart(db, ctx, CartCreate(channel=Channel.SHOP))
    for item in data.items:
        billing.add_item(db, ctx, cart.id, item.product_id, item.quantity)
    return orders.place_order(
        db, ctx, cart.id, customer_name=data.customer_name, customer_phone=data.customer_phone
    )


def get_order(db: Session, store_slug: str, order_id: uuid.UUID) -> Order:
    """A Shop order of this store, for the customer who placed it (they hold its unguessable id)."""
    ctx = _context(get_merchant(db, store_slug))
    order = db.scalars(scoped(Order, ctx).where(Order.id == order_id, Order.channel == Channel.SHOP)).one_or_none()
    if order is None:
        raise NotFound("Order not found")
    return order
