import re
import uuid

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.core.enums import UserRole
from app.core.types import Schema

# 2-digit state code + 10-char PAN (5 letters, 4 digits, 1 letter) + 1 entity digit + 'Z' + 1 checksum.
_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")


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
    gstin: str | None


class MerchantUpdate(BaseModel):
    """Set or clear the store's GSTIN (null clears it). Shown on bills once set; not required to sell."""

    gstin: str | None = Field(default=None, max_length=15)

    @field_validator("gstin")
    @classmethod
    def _valid_gstin(cls, v: str | None) -> str | None:
        if v is None or v.strip() == "":
            return None
        v = v.strip().upper()
        if not _GSTIN_RE.match(v):
            raise ValueError("Not a valid GSTIN (e.g. 07ABCDE1234F1Z5)")
        return v


class SessionRead(BaseModel):
    user: UserRead
    merchant: MerchantRead
