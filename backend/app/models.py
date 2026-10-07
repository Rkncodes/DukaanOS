"""Imports every model so Base.metadata is complete (used by Alembic and tests)."""

from app.core.db import Base
from app.modules.billing.models import Cart, CartItem
from app.modules.catalog.models import Category, Product
from app.modules.customers.models import Customer
from app.modules.khata.models import KhataEntry
from app.modules.merchants.models import Merchant, User
from app.modules.orders.models import Order, OrderItem
from app.modules.payments.models import Payment, PaytmPayment
from app.modules.vision.models import ProductReferenceImage

__all__ = [
    "Base",
    "Cart",
    "CartItem",
    "Category",
    "Customer",
    "KhataEntry",
    "Merchant",
    "Order",
    "OrderItem",
    "Payment",
    "PaytmPayment",
    "Product",
    "ProductReferenceImage",
    "User",
]
