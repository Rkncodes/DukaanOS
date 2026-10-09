"""Business activity over time: trend and ranking views computed live from orders,
customers, products and categories. Nothing here is stored — same spirit as
app.modules.insights, but looking backward over a range instead of at today's opportunities.
"""

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.clock import store_day_start, store_now, store_timezone
from app.core.enums import OrderStatus
from app.core.tenancy import TenantContext
from app.modules.analytics.schemas import CategoryBreakdown, SalesTrendPoint, TopCustomer, TopProduct
from app.modules.catalog.models import Category, Product
from app.modules.customers.models import Customer
from app.modules.orders.models import Order, OrderItem

DEFAULT_DAYS = 14
DEFAULT_LIMIT = 8


def sales_trend(db: Session, ctx: TenantContext, *, days: int = DEFAULT_DAYS) -> list[SalesTrendPoint]:
    """One point per day, oldest first, with zero-filled gaps so the line never breaks."""
    since = store_day_start() - timedelta(days=days - 1)
    stmt = select(Order.created_at, Order.total).where(
        Order.merchant_id == ctx.merchant_id, Order.status == OrderStatus.COMPLETED, Order.created_at >= since
    )
    tz = store_timezone()
    buckets: dict[date, tuple[Decimal, int]] = {}
    for created_at, total in db.execute(stmt):
        day = created_at.astimezone(tz).date()
        revenue, orders = buckets.get(day, (Decimal(0), 0))
        buckets[day] = (revenue + total, orders + 1)

    today = store_now().date()
    return [
        SalesTrendPoint(date=day, revenue=buckets.get(day, (Decimal(0), 0))[0], orders=buckets.get(day, (Decimal(0), 0))[1])
        for day in (today - timedelta(days=offset) for offset in range(days - 1, -1, -1))
    ]


def top_products(db: Session, ctx: TenantContext, *, days: int = DEFAULT_DAYS, limit: int = DEFAULT_LIMIT) -> list[TopProduct]:
    """Ranked by revenue. Uses OrderItem's own product_name snapshot, so a renamed or
    deleted product still reports correctly against historical bills."""
    since = store_now() - timedelta(days=days)
    line_total = OrderItem.quantity * OrderItem.unit_price
    stmt = (
        select(OrderItem.product_id, OrderItem.product_name, func.sum(line_total), func.sum(OrderItem.quantity))
        .join(Order, Order.id == OrderItem.order_id)
        .where(Order.merchant_id == ctx.merchant_id, Order.status == OrderStatus.COMPLETED, Order.created_at >= since)
        .group_by(OrderItem.product_id, OrderItem.product_name)
        .order_by(func.sum(line_total).desc())
        .limit(limit)
    )
    return [TopProduct(product_id=pid, name=name, revenue=revenue, quantity=qty) for pid, name, revenue, qty in db.execute(stmt)]


def top_customers(db: Session, ctx: TenantContext, *, days: int = DEFAULT_DAYS, limit: int = DEFAULT_LIMIT) -> list[TopCustomer]:
    """Ranked by revenue. Anonymous counter sales (no customer) don't count toward anyone."""
    since = store_now() - timedelta(days=days)
    stmt = (
        select(Customer.id, Customer.name, func.sum(Order.total), func.count(Order.id))
        .join(Order, Order.customer_id == Customer.id)
        .where(
            Customer.merchant_id == ctx.merchant_id,
            Order.merchant_id == ctx.merchant_id,
            Order.status == OrderStatus.COMPLETED,
            Order.created_at >= since,
        )
        .group_by(Customer.id, Customer.name)
        .order_by(func.sum(Order.total).desc())
        .limit(limit)
    )
    return [TopCustomer(customer_id=cid, name=name, revenue=revenue, order_count=count) for cid, name, revenue, count in db.execute(stmt)]


def category_breakdown(db: Session, ctx: TenantContext, *, days: int = DEFAULT_DAYS) -> list[CategoryBreakdown]:
    """Ranked by revenue, by each product's *current* category (no historical snapshot
    exists for category, unlike product name — this view is about today's merchandising)."""
    since = store_now() - timedelta(days=days)
    line_total = OrderItem.quantity * OrderItem.unit_price
    stmt = (
        select(Category.id, Category.name, func.sum(line_total))
        .select_from(OrderItem)
        .join(Order, Order.id == OrderItem.order_id)
        .join(Product, Product.id == OrderItem.product_id)
        .join(Category, Category.id == Product.category_id)
        .where(Order.merchant_id == ctx.merchant_id, Order.status == OrderStatus.COMPLETED, Order.created_at >= since)
        .group_by(Category.id, Category.name)
        .order_by(func.sum(line_total).desc())
    )
    return [CategoryBreakdown(category_id=cid, name=name, revenue=revenue) for cid, name, revenue in db.execute(stmt)]
