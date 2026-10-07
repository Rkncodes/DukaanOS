"""Salaahkaar over HTTP: whether it can answer, and asking it a question.

The conversation loop is app.modules.assistant.service; what it may look up is
app.modules.assistant.tools; which LLM it talks to is app.modules.assistant.deps.
"""

from fastapi import APIRouter

from app.core.db import DbSession
from app.modules.assistant import service
from app.modules.assistant.deps import Llm
from app.modules.assistant.schemas import AskRequest, AssistantAnswer, AssistantCapability, AssistantStatus
from app.modules.assistant.tools import TOOLS
from app.modules.auth.deps import CurrentUser, Tenant

router = APIRouter(prefix="/assistant", tags=["assistant"])


@router.get("/status")
def get_status(ctx: Tenant, llm: Llm) -> AssistantStatus:
    return AssistantStatus(
        available=llm is not None,
        reason=None if llm is not None else service.NOT_CONFIGURED,
        # What it can do today: look things up. Tools that change data are not offered yet.
        capabilities=[
            AssistantCapability(name=t.name, description=t.description, needs_confirmation=t.mutates)
            for t in TOOLS.values()
            if not t.mutates
        ],
    )


@router.post("/ask")
def ask(data: AskRequest, db: DbSession, ctx: Tenant, user: CurrentUser, llm: Llm) -> AssistantAnswer:
    if llm is None:
        raise service.AssistantUnavailable(service.NOT_CONFIGURED)
    # Read-only: nothing to commit.
    return service.ask(
        db, ctx, llm, data.question, store_name=user.merchant.store_name, history=data.history
    )
