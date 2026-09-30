import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.core.types import Money, MoneyOut, QuantityOut, Schema


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class CategoryUpdate(CategoryCreate):
    pass


class CategoryRead(Schema):
    id: uuid.UUID
    name: str


class ProductBase(BaseModel):
    category_id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=160)
    sku: str | None = Field(default=None, max_length=64)
    barcode: str | None = Field(default=None, max_length=64)
    price: Money
    cost_price: Money | None = None
    unit: str = Field(default="pcs", max_length=16)
    image_url: str | None = Field(default=None, max_length=500)


class ProductCreate(ProductBase):
    # Opening stock only; afterwards stock changes via inventory adjustments / sales.
    stock_quantity: Decimal = Field(default=Decimal(0), ge=0, max_digits=12, decimal_places=3)


class ProductUpdate(BaseModel):
    """Partial update. Stock is intentionally absent: use /inventory/adjustments."""

    model_config = ConfigDict(extra="forbid")

    category_id: uuid.UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=160)
    sku: str | None = Field(default=None, max_length=64)
    barcode: str | None = Field(default=None, max_length=64)
    price: Money | None = None
    cost_price: Money | None = None
    unit: str | None = Field(default=None, max_length=16)
    image_url: str | None = Field(default=None, max_length=500)
    is_active: bool | None = None


class ProductRead(Schema):
    id: uuid.UUID
    category_id: uuid.UUID | None
    name: str
    sku: str | None
    barcode: str | None
    price: MoneyOut
    cost_price: MoneyOut | None
    stock_quantity: QuantityOut
    unit: str
    image_url: str | None
    is_active: bool
    created_at: datetime
    updated_at: datetime
