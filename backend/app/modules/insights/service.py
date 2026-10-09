"""Business opportunities, computed fresh from existing data on every call — never stored,
the same philosophy as a khata balance (app.modules.khata.service). The only thing persisted
is what a staff member did about one (app.modules.insights.models.InsightAction), keyed by
the insight's stable key, so a colleague can see it was already handled.
"""

import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from itertools import groupby

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.clock import store_day_start, store_now, store_timezone
from app.core.enums import InsightActionStatus, KhataEntryType, OrderStatus
from app.core.tenancy import TenantContext, scoped
from app.modules.catalog import service as catalog
from app.modules.customers.models import Customer
from app.modules.insights.models import InsightAction
from app.modules.insights.schemas import InsightActionIn, InsightActionRead, InsightKind, InsightRead, InsightSummary
from app.modules.khata import service as khata
from app.modules.khata.models import KhataEntry
from app.modules.orders.models import Order, OrderItem

VELOCITY_WINDOW_DAYS = 14
STOCKOUT_DAYS_THRESHOLD = 7
DEAD_STOCK_WINDOW_DAYS = 21
WINBACK_MIN_ORDERS = 2
WINBACK_MULTIPLIER = 1.75  # a customer is "overdue" once the gap since their last order exceeds this times their usual gap
KHATA_RISK_THRESHOLD = Decimal("300")
KHATA_RISK_STALE_DAYS = 14

_KIND_BASE_SCORE = {
    InsightKind.KHATA_RISK: 70.0,
    InsightKind.STOCKOUT_RISK: 60.0,
    InsightKind.CUSTOMER_WINBACK: 50.0,
    InsightKind.DEAD_STOCK: 40.0,
}


def _qty(amount: Decimal) -> str:
    return str(amount.normalize()) if amount != amount.to_integral() else str(int(amount))


def _velocity(db: Session, ctx: TenantContext, window_days: int) -> dict[uuid.UUID, Decimal]:
    """Units sold per product (completed orders only) in the trailing window_days."""
    since = store_now() - timedelta(days=window_days)
    stmt = (
        select(OrderItem.product_id, func.sum(OrderItem.quantity))
        .join(Order, Order.id == OrderItem.order_id)
        .where(Order.merchant_id == ctx.merchant_id, Order.status == OrderStatus.COMPLETED, Order.created_at >= since)
        .group_by(OrderItem.product_id)
    )
    return {product_id: Decimal(sold) for product_id, sold in db.execute(stmt)}


def _daily_sold_series(db: Session, ctx: TenantContext, window_days: int) -> dict[uuid.UUID, list[Decimal]]:
    """Each product's units sold per day over the trailing window_days, oldest first, zero-filled
    (same day-bucketing as app.modules.analytics.service.sales_trend) -- the shape a trend needs,
    where a flat total loses whether demand is climbing, steady or already drying up."""
    since = store_day_start() - timedelta(days=window_days - 1)
    stmt = (
        select(OrderItem.product_id, Order.created_at, OrderItem.quantity)
        .join(Order, Order.id == OrderItem.order_id)
        .where(Order.merchant_id == ctx.merchant_id, Order.status == OrderStatus.COMPLETED, Order.created_at >= since)
    )
    tz = store_timezone()
    today = store_now().date()
    index = {(today - timedelta(days=offset)): i for i, offset in enumerate(range(window_days - 1, -1, -1))}
    series: dict[uuid.UUID, list[Decimal]] = {}
    for product_id, created_at, quantity in db.execute(stmt):
        i = index.get(created_at.astimezone(tz).date())
        if i is None:
            continue
        series.setdefault(product_id, [Decimal(0)] * window_days)[i] += quantity
    return series


def _linear_trend(values: list[float]) -> tuple[float, float]:
    """Least-squares line (slope, intercept) of `values` against their index (0, 1, 2, ...)."""
    n = len(values)
    mean_x = (n - 1) / 2
    mean_y = sum(values) / n
    covariance = sum((x - mean_x) * (y - mean_y) for x, y in enumerate(values))
    variance = sum((x - mean_x) ** 2 for x in range(n))
    slope = covariance / variance if variance > 0 else 0.0
    return slope, mean_y - slope * mean_x


def _forecast_days_left(stock: Decimal, daily_sold: list[Decimal], *, horizon_days: int = 90) -> tuple[float, float] | None:
    """Fits a trend line to `daily_sold` and projects it forward, a day at a time (demand never
    negative), to find the day the running total would deplete `stock`. Returns
    (days_left, tomorrow's projected velocity), or None if that wouldn't happen within
    horizon_days -- including when demand is trending down to zero before stock runs out, which
    a flat average (total / window) can't tell apart from steady demand that will keep selling."""
    slope, intercept = _linear_trend([float(v) for v in daily_sold])
    n = len(daily_sold)
    tomorrow = max(0.0, intercept + slope * n)
    remaining = float(stock)
    for day_ahead in range(horizon_days):
        projected = max(0.0, intercept + slope * (n + day_ahead))
        if projected <= 0:
            return None  # demand has already trended to zero: a dead-stock risk, not a stockout one
        remaining -= projected
        if remaining <= 0:
            return day_ahead + 1, tomorrow
    return None


def _stockout_risk(db: Session, ctx: TenantContext) -> list[InsightRead]:
    series = _daily_sold_series(db, ctx, VELOCITY_WINDOW_DAYS)
    out = []
    for p in catalog.list_products(db, ctx):
        daily = series.get(p.id)
        sold = sum(daily, Decimal(0)) if daily else Decimal(0)
        if not daily or sold <= 0:
            continue
        forecast = _forecast_days_left(p.stock_quantity, daily)
        if forecast is None:
            continue
        days_left, velocity_tomorrow = forecast
        if days_left > STOCKOUT_DAYS_THRESHOLD:
            continue
        slope, _ = _linear_trend([float(v) for v in daily])
        trend = "climbing" if slope > 0.05 else "slowing" if slope < -0.05 else "steady"
        out.append(
            InsightRead(
                key=f"stockout_risk:{p.id}",
                kind=InsightKind.STOCKOUT_RISK,
                title=f"{p.name} may run out in {days_left:.0f} days",
                detail=f"{_qty(sold)} {p.unit} sold in the last {VELOCITY_WINDOW_DAYS} days ({trend}), "
                f"only {_qty(p.stock_quantity)} {p.unit} left",
                tone="red" if days_left <= 3 else "amber",
                link="/catalogue/stock",
                product_id=p.id,
                metrics={"days_left": float(days_left), "daily_velocity": velocity_tomorrow, "trend_slope": slope},
            )
        )
    return out


def _dead_stock(db: Session, ctx: TenantContext) -> list[InsightRead]:
    sold_recently = set(_velocity(db, ctx, DEAD_STOCK_WINDOW_DAYS).keys())
    out = []
    for p in catalog.list_products(db, ctx):
        if p.id in sold_recently or p.stock_quantity <= 0:
            continue
        out.append(
            InsightRead(
                key=f"dead_stock:{p.id}",
                kind=InsightKind.DEAD_STOCK,
                title=f"{p.name} hasn't sold in {DEAD_STOCK_WINDOW_DAYS}+ days",
                detail=f"{_qty(p.stock_quantity)} {p.unit} still on the shelf",
                tone="amber",
                link="/catalogue/stock",
                product_id=p.id,
                metrics={"stock": float(p.stock_quantity)},
            )
        )
    return out


def _customer_winback(db: Session, ctx: TenantContext) -> list[InsightRead]:
    stmt = (
        select(Order.customer_id, Order.created_at)
        .where(Order.merchant_id == ctx.merchant_id, Order.status == OrderStatus.COMPLETED, Order.customer_id.is_not(None))
        .order_by(Order.customer_id, Order.created_at)
    )
    rows = list(db.execute(stmt))
    customers = {c.id: c for c in db.scalars(scoped(Customer, ctx))}
    now = store_now()
    out = []
    for customer_id, group in groupby(rows, key=lambda r: r[0]):
        dates: list[datetime] = [r[1] for r in group]
        if len(dates) < WINBACK_MIN_ORDERS:
            continue
        gaps = [b - a for a, b in zip(dates, dates[1:])]
        avg_gap = sum(gaps, timedelta()) / len(gaps)
        if avg_gap <= timedelta(0):
            continue
        since_last = now - dates[-1]
        if since_last <= avg_gap * WINBACK_MULTIPLIER:
            continue
        customer = customers[customer_id]
        out.append(
            InsightRead(
                key=f"customer_winback:{customer_id}",
                kind=InsightKind.CUSTOMER_WINBACK,
                title=f"{customer.name} hasn't come back in {since_last.days} days",
                detail=f"Usually buys every {avg_gap.days} days",
                tone="amber",
                link=f"/khata/{customer_id}",
                customer_id=customer_id,
                metrics={"avg_cadence_days": avg_gap.days, "days_since_last_order": since_last.days},
            )
        )
    return out


def _last_payment_at(db: Session, ctx: TenantContext) -> dict[uuid.UUID, datetime]:
    stmt = (
        select(KhataEntry.customer_id, func.max(KhataEntry.created_at))
        .where(KhataEntry.merchant_id == ctx.merchant_id, KhataEntry.type == KhataEntryType.PAYMENT)
        .group_by(KhataEntry.customer_id)
    )
    return {customer_id: last for customer_id, last in db.execute(stmt)}


def _khata_risk(db: Session, ctx: TenantContext) -> list[InsightRead]:
    last_payment = _last_payment_at(db, ctx)
    cutoff = store_now() - timedelta(days=KHATA_RISK_STALE_DAYS)
    out = []
    for b in khata.list_balances(db, ctx, outstanding_only=True):
        if b.balance < KHATA_RISK_THRESHOLD:
            continue
        last = last_payment.get(b.customer_id)
        if last is not None and last >= cutoff:
            continue
        days_since_payment = (store_now() - last).days if last else None
        out.append(
            InsightRead(
                key=f"khata_risk:{b.customer_id}",
                kind=InsightKind.KHATA_RISK,
                title=f"{b.customer_name} owes ₹{b.balance} with no recent payment",
                detail="Never paid back" if last is None else f"Last paid {days_since_payment} days ago",
                tone="red" if b.balance >= KHATA_RISK_THRESHOLD * 2 else "amber",
                link=f"/khata/{b.customer_id}",
                customer_id=b.customer_id,
                metrics={"balance": float(b.balance), "days_since_payment": days_since_payment},
            )
        )
    return out


def _urgency(item: InsightRead) -> float:
    base = _KIND_BASE_SCORE[item.kind]
    if item.kind == InsightKind.STOCKOUT_RISK:
        return base + max(0.0, STOCKOUT_DAYS_THRESHOLD - item.metrics["days_left"])
    if item.kind == InsightKind.KHATA_RISK:
        return base + min(30.0, item.metrics["balance"] / 100)
    if item.kind == InsightKind.CUSTOMER_WINBACK:
        return base + min(20.0, item.metrics["days_since_last_order"] / 5)
    return base


def list_insights(db: Session, ctx: TenantContext, *, include_resolved: bool = False) -> list[InsightRead]:
    items = [*_stockout_risk(db, ctx), *_dead_stock(db, ctx), *_customer_winback(db, ctx), *_khata_risk(db, ctx)]
    actions = {a.insight_key: a for a in db.scalars(scoped(InsightAction, ctx))}
    now = store_now()

    result = []
    for item in items:
        action = actions.get(item.key)
        if action is not None:
            still_snoozed = action.status == InsightActionStatus.SNOOZED and (
                action.snoozed_until is None or action.snoozed_until > now
            )
            handled = action.status in (InsightActionStatus.DISMISSED, InsightActionStatus.RESOLVED)
            if not include_resolved and (still_snoozed or handled):
                continue
            item = item.model_copy(update={"action": InsightActionRead.model_validate(action)})
        result.append(item)

    result.sort(key=_urgency, reverse=True)
    return result


def _completed_orders_between(db: Session, ctx: TenantContext, start: datetime, end: datetime) -> list[Order]:
    stmt = select(Order).where(
        Order.merchant_id == ctx.merchant_id,
        Order.status == OrderStatus.COMPLETED,
        Order.created_at >= start,
        Order.created_at < end,
    )
    return list(db.scalars(stmt))


def _pct_change(current: float, baseline: float) -> float | None:
    if baseline <= 0:
        return None
    return round((current - baseline) / baseline * 100, 1)


def summary(db: Session, ctx: TenantContext) -> InsightSummary:
    today_start = store_day_start()
    week_start = today_start - timedelta(days=7)

    today_orders = _completed_orders_between(db, ctx, today_start, store_now())
    prior_week_orders = _completed_orders_between(db, ctx, week_start, today_start)

    sales_today = sum((o.total for o in today_orders), Decimal(0))
    orders_today = len(today_orders)

    avg_daily_sales = float(sum((o.total for o in prior_week_orders), Decimal(0))) / 7
    avg_daily_orders = len(prior_week_orders) / 7

    outstanding = sum((b.balance for b in khata.list_balances(db, ctx, outstanding_only=True)), Decimal(0))

    return InsightSummary(
        sales_today=sales_today,
        sales_trend_pct=_pct_change(float(sales_today), avg_daily_sales),
        orders_today=orders_today,
        orders_trend_pct=_pct_change(orders_today, avg_daily_orders),
        khata_outstanding=outstanding,
        open_insight_count=len(list_insights(db, ctx)),
    )


def set_action(db: Session, ctx: TenantContext, insight_key: str, data: InsightActionIn) -> InsightAction:
    existing = db.scalars(scoped(InsightAction, ctx).where(InsightAction.insight_key == insight_key)).one_or_none()
    if existing is None:
        existing = InsightAction(merchant_id=ctx.merchant_id, insight_key=insight_key)
        db.add(existing)
    existing.status = data.status
    existing.note = data.note
    existing.snoozed_until = data.snoozed_until
    if data.status == InsightActionStatus.RESOLVED:
        existing.resolved_by = ctx.user_id
    db.flush()
    return existing
