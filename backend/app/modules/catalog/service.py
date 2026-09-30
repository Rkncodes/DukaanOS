import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.tenancy import TenantContext, get_owned, scoped
from app.modules.catalog.models import Category, Product
from app.modules.catalog.schemas import CategoryCreate, CategoryUpdate, ProductCreate, ProductUpdate

# ---- categories ----


def list_categories(db: Session, ctx: TenantContext) -> list[Category]:
    return list(db.scalars(scoped(Category, ctx).order_by(Category.name)))


def create_category(db: Session, ctx: TenantContext, data: CategoryCreate) -> Category:
    category = Category(merchant_id=ctx.merchant_id, name=data.name)
    db.add(category)
    db.flush()
    return category


def update_category(db: Session, ctx: TenantContext, category_id: uuid.UUID, data: CategoryUpdate) -> Category:
    category = get_owned(db, Category, category_id, ctx)
    category.name = data.name
    db.flush()
    return category


def delete_category(db: Session, ctx: TenantContext, category_id: uuid.UUID) -> None:
    db.delete(get_owned(db, Category, category_id, ctx))
    db.flush()


# ---- products ----


def list_products(
    db: Session,
    ctx: TenantContext,
    *,
    q: str | None = None,
    category_id: uuid.UUID | None = None,
    barcode: str | None = None,
    include_inactive: bool = False,
) -> list[Product]:
    stmt = scoped(Product, ctx).order_by(Product.name)
    if not include_inactive:
        stmt = stmt.where(Product.is_active.is_(True))
    if q:
        stmt = stmt.where(Product.name.ilike(f"%{q}%"))
    if category_id:
        stmt = stmt.where(Product.category_id == category_id)
    if barcode:
        stmt = stmt.where(Product.barcode == barcode)
    return list(db.scalars(stmt))


def get_product(db: Session, ctx: TenantContext, product_id: uuid.UUID) -> Product:
    return get_owned(db, Product, product_id, ctx)


def find_by_barcode(db: Session, ctx: TenantContext, barcode: str) -> Product | None:
    return db.scalars(scoped(Product, ctx).where(Product.barcode == barcode, Product.is_active.is_(True))).first()


def find_by_name(db: Session, ctx: TenantContext, name: str) -> Product | None:
    """Exact case-insensitive name match among active products. Fuzzy matching comes later."""
    matches = db.scalars(
        scoped(Product, ctx).where(func.lower(Product.name) == name.strip().lower(), Product.is_active.is_(True))
    ).all()
    return matches[0] if len(matches) == 1 else None


def _check_category(db: Session, ctx: TenantContext, category_id: uuid.UUID | None) -> None:
    if category_id is not None:
        get_owned(db, Category, category_id, ctx)  # must belong to the same merchant


def create_product(db: Session, ctx: TenantContext, data: ProductCreate) -> Product:
    _check_category(db, ctx, data.category_id)
    product = Product(merchant_id=ctx.merchant_id, **data.model_dump())
    db.add(product)
    db.flush()
    return product


def update_product(db: Session, ctx: TenantContext, product_id: uuid.UUID, data: ProductUpdate) -> Product:
    product = get_owned(db, Product, product_id, ctx)
    changes = data.model_dump(exclude_unset=True)
    if "category_id" in changes:
        _check_category(db, ctx, changes["category_id"])
    for field, value in changes.items():
        setattr(product, field, value)
    db.flush()
    return product


def deactivate_product(db: Session, ctx: TenantContext, product_id: uuid.UUID) -> None:
    """Soft delete: products are referenced by historical orders."""
    product = get_owned(db, Product, product_id, ctx)
    product.is_active = False
    db.flush()
