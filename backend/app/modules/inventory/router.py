import uuid
from decimal import Decimal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.core.db import DbSession
from app.modules.auth.deps import Tenant
from app.modules.catalog.schemas import ProductRead
from app.modules.inventory import service

router = APIRouter(prefix="/inventory", tags=["inventory"])


class StockAdjustment(BaseModel):
    product_id: uuid.UUID
    delta: Decimal = Field(max_digits=12, decimal_places=3)


@router.post("/adjustments")
def adjust_stock(data: StockAdjustment, db: DbSession, ctx: Tenant) -> ProductRead:
    product = service.adjust_stock(db, ctx, data.product_id, data.delta)
    db.commit()
    return product
