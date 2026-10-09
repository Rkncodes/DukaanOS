import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, MerchantScoped, Timestamps, UUIDPk
from app.core.enums import InsightActionStatus, enum_check


class InsightAction(UUIDPk, MerchantScoped, Timestamps, Base):
    """What a staff member did about a computed insight, keyed by its stable insight_key
    (e.g. "stockout_risk:<product_id>"). The insight itself is never stored, only this: the
    absence of a row means the insight is still open. See app.modules.insights.service."""

    __tablename__ = "insight_actions"
    __table_args__ = (
        UniqueConstraint("merchant_id", "insight_key"),
        enum_check("status", InsightActionStatus),
    )

    insight_key: Mapped[str] = mapped_column(String(160), index=True)
    status: Mapped[str] = mapped_column(String(20))
    note: Mapped[str | None] = mapped_column(String(500))
    snoozed_until: Mapped[datetime | None]
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
