import uuid
from datetime import date

from pydantic import BaseModel

from app.core.types import MoneyOut, QuantityOut


class SalesTrendPoint(BaseModel):
    date: date
    revenue: MoneyOut
    orders: int


class TopProduct(BaseModel):
    product_id: uuid.UUID
    name: str
    revenue: MoneyOut
    quantity: QuantityOut


class TopCustomer(BaseModel):
    customer_id: uuid.UUID
    name: str
    revenue: MoneyOut
    order_count: int


class CategoryBreakdown(BaseModel):
    category_id: uuid.UUID
    name: str
    revenue: MoneyOut
