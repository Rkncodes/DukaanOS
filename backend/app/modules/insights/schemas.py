import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

from app.core.enums import InsightActionStatus
from app.core.types import MoneyOut, Schema


class InsightKind(StrEnum):
    STOCKOUT_RISK = "stockout_risk"
    DEAD_STOCK = "dead_stock"
    CUSTOMER_WINBACK = "customer_winback"
    KHATA_RISK = "khata_risk"


class InsightActionIn(BaseModel):
    status: InsightActionStatus
    note: str | None = Field(default=None, max_length=500)
    snoozed_until: datetime | None = None


class InsightActionRead(Schema):
    status: InsightActionStatus
    note: str | None
    snoozed_until: datetime | None
    resolved_by: uuid.UUID | None
    updated_at: datetime


class InsightRead(BaseModel):
    key: str
    kind: InsightKind
    title: str
    detail: str
    tone: str  # "amber" | "red" — matches the frontend Tone type directly
    link: str
    product_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    action: InsightActionRead | None = None


class InsightSummary(BaseModel):
    sales_today: MoneyOut
    sales_trend_pct: float | None
    orders_today: int
    orders_trend_pct: float | None
    khata_outstanding: MoneyOut
    open_insight_count: int
