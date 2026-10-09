import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.modules.insights.service import _forecast_days_left, _linear_trend
from app.modules.orders.models import Order
from tests.conftest import create_cart, create_customer, create_product


def _add(client, cart_id: str, **item) -> dict:
    res = client.post(f"/api/v1/carts/{cart_id}/items", json=item)
    assert res.status_code == 200, res.text
    return res.json()


def _checkout(client, cart_id: str, **body) -> dict:
    res = client.post(f"/api/v1/carts/{cart_id}/checkout", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _sale(client, product: dict, qty: str, *, customer_id: str | None = None, method: str = "cash") -> dict:
    cart = create_cart(client, customer_id=customer_id)
    _add(client, cart["id"], product_id=product["id"], quantity=qty)
    return _checkout(client, cart["id"], method=method)


def _backdate(db, order_id: str, when: datetime) -> None:
    order = db.get(Order, uuid.UUID(order_id))
    order.created_at = when
    db.flush()


def _by_key(items: list[dict], prefix: str) -> dict | None:
    return next((i for i in items if i["key"].startswith(prefix)), None)


# ---- the trend math itself ----


def test_linear_trend_reads_slope_and_intercept_off_a_straight_line():
    assert _linear_trend([5.0, 5.0, 5.0, 5.0]) == (0.0, 5.0)
    assert _linear_trend([0.0, 1.0, 2.0, 3.0]) == (1.0, 0.0)
    slope, intercept = _linear_trend([3.0, 2.0, 1.0, 0.0])
    assert (slope, intercept) == (-1.0, 3.0)


def test_climbing_demand_is_forecast_to_run_out_sooner_than_a_flat_average_would_say():
    # 14 days of 0,1,2,...,13 units sold: a flat average (91 / 14 ≈ 6.5/day) says ~7.7 days left.
    daily = [Decimal(i) for i in range(14)]
    flat_average_days_left = 50 / (sum(daily) / 14)
    assert round(float(flat_average_days_left), 1) == 7.7  # the old method would *not* flag this (> 7 day threshold)

    days_left, tomorrow = _forecast_days_left(Decimal(50), daily)
    assert days_left == 4  # the trend (climbing toward 14/day) catches it well before the flat average would
    assert tomorrow == 14.0


def test_demand_that_has_already_ended_is_not_flagged_even_though_a_flat_average_would_panic():
    # 14 days declining in a straight line from 13 to 0: today's demand is already zero.
    daily = [Decimal(13 - i) for i in range(14)]
    flat_average_days_left = 5 / (sum(daily) / 14)
    assert float(flat_average_days_left) < 1  # the old method would scream "red, <1 day left"

    assert _forecast_days_left(Decimal(5), daily) is None  # the trend knows better: there's no demand left to deplete it


def test_forecast_matches_a_flat_average_when_demand_is_actually_flat():
    daily = [Decimal(2)] * 14
    days_left, tomorrow = _forecast_days_left(Decimal(10), daily)
    assert (days_left, tomorrow) == (5, 2.0)  # 10 / 2 per day, same answer a flat average would give


# ---- the real pipeline, against the API ----


def test_stockout_risk_ignores_a_product_whose_sales_have_already_dried_up(client_a, db):
    # 45 units on the shelf to begin with; the sales below take it down to 5.
    product = create_product(client_a, name="Dying Snack", price="10.00", stock_quantity="45")
    # Sold heavily a week+ ago, nothing in the last several days: a flat 14-day average still
    # divides by a "healthy" total, but there is no real demand left to run the shelf down.
    for days_ago, qty in [(13, "10"), (12, "9"), (11, "8"), (10, "7"), (9, "6")]:
        order = _sale(client_a, product, qty)
        _backdate(db, order["id"], datetime.now(UTC) - timedelta(days=days_ago))

    insights = client_a.get("/api/v1/insights").json()
    assert _by_key(insights, "stockout_risk") is None


def test_stockout_risk_flags_a_fast_recent_climb_with_low_stock(client_a, db):
    product = create_product(client_a, name="Trending Drink", price="10.00", stock_quantity="50")
    for days_ago, qty in [(5, "2"), (4, "4"), (3, "6"), (2, "8"), (1, "10"), (0, "12")]:
        order = _sale(client_a, product, qty)
        _backdate(db, order["id"], datetime.now(UTC) - timedelta(days=days_ago))

    insight = _by_key(client_a.get("/api/v1/insights").json(), "stockout_risk")
    assert insight is not None
    assert insight["product_id"] == product["id"]
    assert insight["metrics"]["trend_slope"] > 0
    assert "climbing" in insight["detail"]


def test_stockout_risk_is_isolated_per_merchant(client_a, client_b, db):
    product_a = create_product(client_a, name="Scarce A", price="10.00", stock_quantity="2")
    product_b = create_product(client_b, name="Scarce B", price="10.00", stock_quantity="2")
    for client, product in [(client_a, product_a), (client_b, product_b)]:
        order = _sale(client, product, "2")
        _backdate(db, order["id"], datetime.now(UTC) - timedelta(days=1))

    risk_a = _by_key(client_a.get("/api/v1/insights").json(), "stockout_risk")
    assert risk_a is not None and risk_a["product_id"] == product_a["id"]
    assert client_b.get("/api/v1/insights").json().count  # sanity: endpoint works for B too
    risk_b = _by_key(client_b.get("/api/v1/insights").json(), "stockout_risk")
    assert risk_b is not None and risk_b["product_id"] == product_b["id"]


def test_dead_stock_flags_a_product_untouched_in_the_window(client_a):
    create_product(client_a, name="Forgotten Jar", price="10.00", stock_quantity="5")
    insight = _by_key(client_a.get("/api/v1/insights").json(), "dead_stock")
    assert insight is not None and insight["detail"] == "5 pcs still on the shelf"


def test_customer_winback_flags_a_regular_who_has_gone_quiet(client_a, db):
    product = create_product(client_a, price="20.00", stock_quantity="50")
    rahul = create_customer(client_a, name="Rahul")
    for days_ago in (20, 16, 12):
        order = _sale(client_a, product, "1", customer_id=rahul["id"])
        _backdate(db, order["id"], datetime.now(UTC) - timedelta(days=days_ago))
    # Usually buys every ~4 days; it has been 12 days since the last one.

    insight = _by_key(client_a.get("/api/v1/insights").json(), f"customer_winback:{rahul['id']}")
    assert insight is not None
    assert insight["customer_id"] == rahul["id"]
    assert insight["metrics"]["avg_cadence_days"] == 4


def test_khata_risk_flags_a_large_unpaid_balance(client_a):
    product = create_product(client_a, price="500.00", stock_quantity="10")
    rohit = create_customer(client_a, name="Rohit")
    _sale(client_a, product, "1", customer_id=rohit["id"], method="khata")

    insight = _by_key(client_a.get("/api/v1/insights").json(), f"khata_risk:{rohit['id']}")
    assert insight is not None and insight["metrics"]["balance"] == 500.0


def test_resolving_an_insight_hides_it_and_a_snooze_expires(client_a):
    create_product(client_a, name="Shelved Item", price="10.00", stock_quantity="5")
    key = _by_key(client_a.get("/api/v1/insights").json(), "dead_stock")["key"]
    url = f"/api/v1/insights/{key.replace(':', '%3A')}/actions"

    client_a.post(url, json={"status": "resolved"})
    assert _by_key(client_a.get("/api/v1/insights").json(), "dead_stock") is None
    assert _by_key(client_a.get("/api/v1/insights", params={"include_resolved": True}).json(), "dead_stock") is not None

    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    client_a.post(url, json={"status": "snoozed", "snoozed_until": past})
    assert _by_key(client_a.get("/api/v1/insights").json(), "dead_stock") is not None  # the snooze already expired
