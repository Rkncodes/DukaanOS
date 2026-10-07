from fastapi import APIRouter
from sqlalchemy import text

from app.core.db import DbSession
from app.core.errors import ERROR_RESPONSES
from app.modules.assistant.router import router as assistant_router
from app.modules.auth.router import router as auth_router
from app.modules.billing.router import router as billing_router
from app.modules.catalog.router import router as catalog_router
from app.modules.customers.router import router as customers_router
from app.modules.inventory.router import router as inventory_router
from app.modules.khata.router import router as khata_router
from app.modules.orders.router import router as orders_router
from app.modules.parchi.router import router as parchi_router
from app.modules.payments.router import router as payments_router
from app.modules.shop.router import router as shop_router
from app.modules.vision.router import router as vision_router
from app.modules.voice.router import router as voice_router

API_PREFIX = "/api/v1"
# The Shop storefront is the only unauthenticated part: /api/v1/public/stores/{store_slug}/...,
# resolved to a TenantContext by slug (app.modules.shop).

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
    payments_router,
    khata_router,
    vision_router,
    parchi_router,
    voice_router,
    shop_router,
    assistant_router,
):
    api_router.include_router(router)
