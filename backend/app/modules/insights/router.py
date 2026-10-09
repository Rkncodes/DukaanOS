from fastapi import APIRouter

from app.core.db import DbSession
from app.modules.auth.deps import Tenant
from app.modules.insights import service
from app.modules.insights.schemas import InsightActionIn, InsightActionRead, InsightRead, InsightSummary

router = APIRouter(prefix="/insights", tags=["insights"])


@router.get("")
def list_insights(db: DbSession, ctx: Tenant, include_resolved: bool = False) -> list[InsightRead]:
    return service.list_insights(db, ctx, include_resolved=include_resolved)


@router.get("/summary")
def get_summary(db: DbSession, ctx: Tenant) -> InsightSummary:
    return service.summary(db, ctx)


@router.post("/{insight_key}/actions")
def act_on_insight(insight_key: str, data: InsightActionIn, db: DbSession, ctx: Tenant) -> InsightActionRead:
    action = service.set_action(db, ctx, insight_key, data)
    db.commit()
    return action
