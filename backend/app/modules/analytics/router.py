from fastapi import APIRouter, Query

from app.core.db import DbSession
from app.modules.analytics import service
from app.modules.analytics.schemas import CategoryBreakdown, SalesTrendPoint, TopCustomer, TopProduct
from app.modules.auth.deps import Tenant

router = APIRouter(prefix="/analytics", tags=["analytics"])

Days = Query(default=service.DEFAULT_DAYS, ge=1, le=90)
Limit = Query(default=service.DEFAULT_LIMIT, ge=1, le=50)


@router.get("/sales-trend")
def sales_trend(db: DbSession, ctx: Tenant, days: int = Days) -> list[SalesTrendPoint]:
    return service.sales_trend(db, ctx, days=days)


@router.get("/top-products")
def top_products(db: DbSession, ctx: Tenant, days: int = Days, limit: int = Limit) -> list[TopProduct]:
    return service.top_products(db, ctx, days=days, limit=limit)


@router.get("/top-customers")
def top_customers(db: DbSession, ctx: Tenant, days: int = Days, limit: int = Limit) -> list[TopCustomer]:
    return service.top_customers(db, ctx, days=days, limit=limit)


@router.get("/category-breakdown")
def category_breakdown(db: DbSession, ctx: Tenant, days: int = Days) -> list[CategoryBreakdown]:
    return service.category_breakdown(db, ctx, days=days)
