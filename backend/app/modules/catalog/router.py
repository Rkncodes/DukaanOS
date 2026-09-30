import uuid

from fastapi import APIRouter, status

from app.core.db import DbSession
from app.modules.auth.deps import Tenant
from app.modules.catalog import service
from app.modules.catalog.schemas import (
    CategoryCreate,
    CategoryRead,
    CategoryUpdate,
    ProductCreate,
    ProductRead,
    ProductUpdate,
)

router = APIRouter(tags=["catalog"])


@router.get("/categories")
def list_categories(db: DbSession, ctx: Tenant) -> list[CategoryRead]:
    return service.list_categories(db, ctx)


@router.post("/categories", status_code=status.HTTP_201_CREATED)
def create_category(data: CategoryCreate, db: DbSession, ctx: Tenant) -> CategoryRead:
    category = service.create_category(db, ctx, data)
    db.commit()
    return category


@router.patch("/categories/{category_id}")
def update_category(category_id: uuid.UUID, data: CategoryUpdate, db: DbSession, ctx: Tenant) -> CategoryRead:
    category = service.update_category(db, ctx, category_id, data)
    db.commit()
    return category


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(category_id: uuid.UUID, db: DbSession, ctx: Tenant) -> None:
    service.delete_category(db, ctx, category_id)
    db.commit()


@router.get("/products")
def list_products(
    db: DbSession,
    ctx: Tenant,
    q: str | None = None,
    category_id: uuid.UUID | None = None,
    barcode: str | None = None,
    include_inactive: bool = False,
) -> list[ProductRead]:
    return service.list_products(
        db, ctx, q=q, category_id=category_id, barcode=barcode, include_inactive=include_inactive
    )


@router.post("/products", status_code=status.HTTP_201_CREATED)
def create_product(data: ProductCreate, db: DbSession, ctx: Tenant) -> ProductRead:
    product = service.create_product(db, ctx, data)
    db.commit()
    return product


@router.get("/products/{product_id}")
def get_product(product_id: uuid.UUID, db: DbSession, ctx: Tenant) -> ProductRead:
    return service.get_product(db, ctx, product_id)


@router.patch("/products/{product_id}")
def update_product(product_id: uuid.UUID, data: ProductUpdate, db: DbSession, ctx: Tenant) -> ProductRead:
    product = service.update_product(db, ctx, product_id, data)
    db.commit()
    return product


@router.delete("/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(product_id: uuid.UUID, db: DbSession, ctx: Tenant) -> None:
    service.deactivate_product(db, ctx, product_id)
    db.commit()
