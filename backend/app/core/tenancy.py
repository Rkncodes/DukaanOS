"""Merchant isolation.

Every service function operating on merchant-owned data takes a TenantContext.
The merchant_id comes from the authenticated user (never from the client), and
all reads go through `scoped` / `get_owned`, which filter by merchant_id.
Records belonging to another merchant are indistinguishable from missing ones (404).
"""

import uuid
from dataclasses import dataclass
from typing import TypeVar

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.core.errors import NotFound

T = TypeVar("T")


@dataclass(frozen=True)
class TenantContext:
    merchant_id: uuid.UUID
    user_id: uuid.UUID | None = None  # None for system actions (e.g. seed)
    role: str | None = None


def scoped(model: type[T], ctx: TenantContext) -> Select[tuple[T]]:
    return select(model).where(model.merchant_id == ctx.merchant_id)  # type: ignore[attr-defined]


def get_owned(
    db: Session,
    model: type[T],
    id: uuid.UUID | None,
    ctx: TenantContext,
    *,
    label: str | None = None,
    for_update: bool = False,
) -> T:
    stmt = scoped(model, ctx).where(model.id == id)  # type: ignore[attr-defined]
    if for_update:
        stmt = stmt.with_for_update()
    obj = db.scalars(stmt).one_or_none() if id is not None else None
    if obj is None:
        raise NotFound(f"{label or model.__name__} not found")
    return obj
