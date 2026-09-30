import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.core.types import Schema


class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=20)


class CustomerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=20)


class CustomerRead(Schema):
    id: uuid.UUID
    name: str
    phone: str | None
    created_at: datetime
    updated_at: datetime
