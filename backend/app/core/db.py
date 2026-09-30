import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import Depends
from sqlalchemy import DateTime, ForeignKey, MetaData, Numeric, create_engine, func
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, declared_attr, mapped_column, sessionmaker

from app.core.config import settings

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = {
        Decimal: Numeric(12, 2),  # money; quantities override with QUANTITY
        datetime: DateTime(timezone=True),
    }


QUANTITY = Numeric(12, 3)  # supports loose items sold by weight/volume


class UUIDPk:
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)


def utcnow() -> datetime:
    # Set in Python (not Postgres now(), which is fixed per transaction) so that rows
    # written in one transaction still have a meaningful order.
    return datetime.now(UTC)


class CreatedAt:
    created_at: Mapped[datetime] = mapped_column(default=utcnow, server_default=func.now())


class Timestamps(CreatedAt):
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, server_default=func.now(), onupdate=utcnow)


class MerchantScoped:
    """Mixin for every merchant-owned table. Queries must go through app.core.tenancy."""

    @declared_attr
    def merchant_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)


engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """One session per request. Routers own the transaction boundary (db.commit());
    services only flush so they can be composed (e.g. checkout -> inventory/payments/khata)."""
    with SessionLocal() as session:
        yield session


DbSession = Annotated[Session, Depends(get_db)]
