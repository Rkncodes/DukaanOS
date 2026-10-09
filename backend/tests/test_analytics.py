import uuid
from datetime import UTC, datetime, timedelta

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


def test_sales_trend_sums_revenue_per_day_and_zero_fills_gaps(client_a, db):
    """Two sales three days apart: the day between them reports zero, not a gap."""
    product = create_product(client_a, price="50.00", stock_quantity="100")
    today = _sale(client_a, product, "2")  # 100.00
    older = _sale(client_a, product, "1")  # 50.00
    _backdate(db, older["id"], datetime.now(UTC) - timedelta(days=3))

    trend = client_a.get("/api/v1/analytics/sales-trend", params={"days": 7}).json()
    assert len(trend) == 7
    by_offset = {i: p for i, p in enumerate(reversed(trend))}  # 0 = today, 3 = three days ago
    assert by_offset[0]["revenue"] == "100.00" and by_offset[0]["orders"] == 1
    assert by_offset[3]["revenue"] == "50.00" and by_offset[3]["orders"] == 1
    assert by_offset[1]["revenue"] == "0.00" and by_offset[1]["orders"] == 0  # the gap


def test_sales_trend_excludes_orders_outside_the_window(client_a, db):
    product = create_product(client_a, price="20.00", stock_quantity="10")
    order = _sale(client_a, product, "1")
    _backdate(db, order["id"], datetime.now(UTC) - timedelta(days=10))

    trend = client_a.get("/api/v1/analytics/sales-trend", params={"days": 7}).json()
    assert sum(float(p["revenue"]) for p in trend) == 0
    assert sum(p["orders"] for p in trend) == 0


def test_top_products_ranks_by_revenue_and_respects_limit(client_a):
    cheap = create_product(client_a, name="Cheap", price="10.00", stock_quantity="50", barcode="1111111111111")
    pricey = create_product(client_a, name="Pricey", price="200.00", stock_quantity="50", barcode="2222222222222")
    mid = create_product(client_a, name="Mid", price="60.00", stock_quantity="50", barcode="3333333333333")
    _sale(client_a, cheap, "3")  # 30.00
    _sale(client_a, pricey, "1")  # 200.00
    _sale(client_a, mid, "2")  # 120.00

    top = client_a.get("/api/v1/analytics/top-products", params={"days": 7}).json()
    assert [p["name"] for p in top] == ["Pricey", "Mid", "Cheap"]
    assert top[0]["revenue"] == "200.00" and top[0]["quantity"] == "1.000"

    limited = client_a.get("/api/v1/analytics/top-products", params={"days": 7, "limit": 1}).json()
    assert [p["name"] for p in limited] == ["Pricey"]


def test_top_customers_ranks_by_revenue_and_excludes_anonymous_sales(client_a):
    product = create_product(client_a, price="100.00", stock_quantity="50")
    rahul = create_customer(client_a, name="Rahul", phone="1")
    priya = create_customer(client_a, name="Priya", phone="2")
    _sale(client_a, product, "1", customer_id=rahul["id"])  # 100.00
    _sale(client_a, product, "3", customer_id=priya["id"], method="khata")  # 300.00
    _sale(client_a, product, "5")  # anonymous counter sale: 500.00, must not appear

    top = client_a.get("/api/v1/analytics/top-customers", params={"days": 7}).json()
    assert [(c["name"], c["revenue"], c["order_count"]) for c in top] == [
        ("Priya", "300.00", 1),
        ("Rahul", "100.00", 1),
    ]


def test_category_breakdown_sums_by_each_products_current_category(client_a):
    snacks = client_a.post("/api/v1/categories", json={"name": "Snacks"}).json()
    drinks = client_a.post("/api/v1/categories", json={"name": "Drinks"}).json()
    chips = create_product(client_a, name="Chips", price="20.00", stock_quantity="50", category_id=snacks["id"])
    cola = create_product(client_a, name="Cola", price="40.00", stock_quantity="50", category_id=drinks["id"])
    _sale(client_a, chips, "2")  # 40.00 snacks
    _sale(client_a, cola, "3")  # 120.00 drinks

    breakdown = client_a.get("/api/v1/analytics/category-breakdown", params={"days": 7}).json()
    assert [(b["name"], b["revenue"]) for b in breakdown] == [("Drinks", "120.00"), ("Snacks", "40.00")]


def test_analytics_is_isolated_per_merchant(client_a, client_b):
    product_a = create_product(client_a, price="100.00", stock_quantity="10")
    product_b = create_product(client_b, price="999.00", stock_quantity="10")
    _sale(client_a, product_a, "1")
    _sale(client_b, product_b, "1")

    trend_a = client_a.get("/api/v1/analytics/sales-trend", params={"days": 1}).json()
    assert float(trend_a[0]["revenue"]) == 100.00

    top_products_a = client_a.get("/api/v1/analytics/top-products").json()
    assert {p["product_id"] for p in top_products_a} == {product_a["id"]}
