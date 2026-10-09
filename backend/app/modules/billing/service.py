"""Cart/bill building. The single convergence point for every billing input:

    Manual / Barcode / Vision / Voice / Parchi / Assistant
        -> resolve_item (tenant-scoped product resolution)
        -> add_item
        -> Cart  -> orders.service.checkout
"""

import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import CartStatus, InputSource
from app.core.errors import Conflict, DomainValidationError, NotFound
from app.core.tenancy import TenantContext, get_owned
from app.integrations.types import RecognizedItem
from app.modules.billing.models import Cart, CartItem
from app.modules.billing.schemas import CartCreate
from app.modules.catalog import service as catalog
from app.modules.catalog.models import Product
from app.modules.customers.models import Customer


def create_cart(db: Session, ctx: TenantContext, data: CartCreate) -> Cart:
    if data.customer_id is not None:
        get_owned(db, Customer, data.customer_id, ctx)
    cart = Cart(merchant_id=ctx.merchant_id, channel=data.channel, customer_id=data.customer_id)
    db.add(cart)
    db.flush()
    return cart


def get_cart(db: Session, ctx: TenantContext, cart_id: uuid.UUID, *, for_update: bool = False) -> Cart:
    return get_owned(db, Cart, cart_id, ctx, for_update=for_update)


def get_open_cart(db: Session, ctx: TenantContext, cart_id: uuid.UUID) -> Cart:
    cart = get_cart(db, ctx, cart_id, for_update=True)
    if cart.status != CartStatus.OPEN:
        raise Conflict(f"Cart is {cart.status}")
    return cart


def set_customer(db: Session, ctx: TenantContext, cart_id: uuid.UUID, customer_id: uuid.UUID | None) -> Cart:
    cart = get_open_cart(db, ctx, cart_id)
    if customer_id is not None:
        get_owned(db, Customer, customer_id, ctx)
    cart.customer_id = customer_id
    db.flush()
    return cart


def add_item(
    db: Session,
    ctx: TenantContext,
    cart_id: uuid.UUID,
    product_id: uuid.UUID,
    quantity: Decimal = Decimal(1),
    source: InputSource = InputSource.MANUAL,
) -> Cart:
    if quantity <= 0:
        raise DomainValidationError("Quantity must be positive")
    cart = get_open_cart(db, ctx, cart_id)
    product = get_owned(db, Product, product_id, ctx)
    if not product.is_active:
        raise DomainValidationError(f"{product.name} is not available")

    existing = next((item for item in cart.items if item.product_id == product.id), None)
    if existing is not None:
        existing.quantity += quantity
    else:
        cart.items.append(
            CartItem(product=product, quantity=quantity, unit_price=product.price, source=source)
        )
    db.flush()
    return cart


def add_item_by_barcode(
    db: Session,
    ctx: TenantContext,
    cart_id: uuid.UUID,
    barcode: str,
    quantity: Decimal = Decimal(1),
    source: InputSource = InputSource.BARCODE,
) -> Cart:
    # Exact match on this merchant's own, on-sale products. A barcode is unique per merchant in the
    # database, so there is never a choice to make, and an unknown code is never guessed at.
    product = catalog.find_by_barcode(db, ctx, barcode)
    if product is None:
        raise NotFound(f"Barcode not found: {barcode}")
    return add_item(db, ctx, cart_id, product.id, quantity, source)


def resolve_item(db: Session, ctx: TenantContext, item: RecognizedItem) -> Product | None:
    """Map a recognized item to one of *this merchant's* products, or None."""
    if item.product_id is not None:
        try:
            return get_owned(db, Product, item.product_id, ctx)
        except NotFound:
            return None
    if item.barcode:
        return catalog.find_by_barcode(db, ctx, item.barcode)
    if item.name_hint:
        return catalog.find_by_name(db, ctx, item.name_hint)
    return None


@dataclass
class RecognizedItemsResult:
    cart: Cart
    unresolved: list[RecognizedItem]


def add_recognized_items(
    db: Session, ctx: TenantContext, cart_id: uuid.UUID, items: list[RecognizedItem]
) -> RecognizedItemsResult:
    """Entry point for Vision / Voice / Parchi adapters. Unresolved items are returned
    for the merchant to confirm instead of being guessed."""
    cart = get_open_cart(db, ctx, cart_id)
    unresolved: list[RecognizedItem] = []
    for item in items:
        product = resolve_item(db, ctx, item)
        if product is None:
            unresolved.append(item)
            continue
        cart = add_item(db, ctx, cart_id, product.id, item.quantity, item.source)
    return RecognizedItemsResult(cart=cart, unresolved=unresolved)


def add_confirmed_items(
    db: Session, ctx: TenantContext, cart_id: uuid.UUID, items: list[RecognizedItem]
) -> Cart:
    """Items the merchant has confirmed (e.g. after a photo scan). All or nothing: any item
    that does not resolve to this merchant's product fails the request (caller does not commit)."""
    result = add_recognized_items(db, ctx, cart_id, items)
    if result.unresolved:
        raise NotFound(
            "Product not found",
            details={"unresolved": [str(i.product_id or i.barcode or i.name_hint) for i in result.unresolved]},
        )
    return result.cart


def _get_item(cart: Cart, item_id: uuid.UUID) -> CartItem:
    item = next((i for i in cart.items if i.id == item_id), None)
    if item is None:
        raise NotFound("Cart item not found")
    return item


def update_item_quantity(
    db: Session, ctx: TenantContext, cart_id: uuid.UUID, item_id: uuid.UUID, quantity: Decimal
) -> Cart:
    if quantity <= 0:
        raise DomainValidationError("Quantity must be positive")
    cart = get_open_cart(db, ctx, cart_id)
    _get_item(cart, item_id).quantity = quantity
    db.flush()
    return cart


def remove_item(db: Session, ctx: TenantContext, cart_id: uuid.UUID, item_id: uuid.UUID) -> Cart:
    cart = get_open_cart(db, ctx, cart_id)
    cart.items.remove(_get_item(cart, item_id))
    db.flush()
    return cart
