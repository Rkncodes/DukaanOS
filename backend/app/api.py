from fastapi import APIRouter
from sqlalchemy import text

from app.core.db import DbSession
from app.core.errors import ERROR_RESPONSES
from app.modules.auth.router import router as auth_router
from app.modules.billing.router import router as billing_router
from app.modules.catalog.router import router as catalog_router
from app.modules.customers.router import router as customers_router
from app.modules.inventory.router import router as inventory_router
from app.modules.khata.router import router as khata_router
from app.modules.orders.router import router as orders_router
from app.modules.vision.router import router as vision_router

API_PREFIX = "/api/v1"
# Reserved for the Shop phase: unauthenticated storefront routes under
# /api/v1/public/stores/{store_slug}/..., resolved to a TenantContext by slug.

api_router = APIRouter(prefix=API_PREFIX, responses=ERROR_RESPONSES)


@api_router.get("/health", tags=["health"])
def health(db: DbSession) -> dict[str, str]:
    db.execute(text("SELECT 1"))
    return {"status": "ok", "database": "ok"}


for router in (
    auth_router,
    catalog_router,
    inventory_router,
    customers_router,
    billing_router,
    orders_router,
    khata_router,
    vision_router,
):
    api_router.include_router(router)
