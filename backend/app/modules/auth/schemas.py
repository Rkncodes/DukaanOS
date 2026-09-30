import uuid

from pydantic import BaseModel, EmailStr, Field

from app.core.enums import UserRole
from app.core.types import Schema


class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    store_name: str = Field(min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=20)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserRead(Schema):
    id: uuid.UUID
    name: str
    email: str
    role: UserRole


class MerchantRead(Schema):
    id: uuid.UUID
    name: str
    email: str | None
    phone: str | None
    store_name: str
    store_slug: str


class SessionRead(BaseModel):
    user: UserRead
    merchant: MerchantRead
