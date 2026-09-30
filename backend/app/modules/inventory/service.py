"""The only place stock_quantity changes after a product is created.

A stock-movement ledger (reasons, audit trail) can be added here later without
touching callers.
"""

import uuid
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.errors import InsufficientStock
from app.core.tenancy import TenantContext, get_owned
from app.modules.catalog.models import Product


def _locked_product(db: Session, ctx: TenantContext, product_id: uuid.UUID) -> Product:
    return get_owned(db, Product, product_id, ctx, for_update=True)


def adjust_stock(db: Session, ctx: TenantContext, product_id: uuid.UUID, delta: Decimal) -> Product:
    """Positive delta = restock, negative = shrinkage/correction."""
    product = _locked_product(db, ctx, product_id)
    new_quantity = product.stock_quantity + delta
    if new_quantity < 0:
        raise InsufficientStock(
            f"Stock for {product.name} cannot go below zero",
            details={"product_id": str(product.id), "available": str(product.stock_quantity)},
        )
    product.stock_quantity = new_quantity
    db.flush()
    return product


def decrement_for_sale(db: Session, ctx: TenantContext, product_id: uuid.UUID, quantity: Decimal) -> Product:
    product = _locked_product(db, ctx, product_id)
    if product.stock_quantity < quantity:
        raise InsufficientStock(
            f"Only {product.stock_quantity.normalize()} {product.unit} of {product.name} in stock",
            details={
                "product_id": str(product.id),
                "requested": str(quantity),
                "available": str(product.stock_quantity),
            },
        )
    product.stock_quantity -= quantity
    db.flush()
    return product
