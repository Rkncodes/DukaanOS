"""Merchant A must never read, modify or reference Merchant B's data.
Cross-merchant access returns 404 (indistinguishable from a missing record)."""

import uuid

import pytest

from app.core.errors import NotFound
from app.core.tenancy import TenantContext
from app.modules.assistant.tools import execute_tool
from tests.conftest import create_cart, create_customer, create_product


@pytest.fixture
def a_data(client_a):
    """A realistic slice of Merchant A's data."""
    category = client_a.post("/api/v1/categories", json={"name": "Snacks"}).json()
    product = create_product(client_a, name="A-Kurkure", barcode="A-111", category_id=category["id"])
    customer = create_customer(client_a, name="A-Rahul", phone="7000000001")
    client_a.post(f"/api/v1/customers/{customer['id']}/khata/credits", json={"amount": "100"})
    order_cart = create_cart(client_a, customer_id=customer["id"])
    client_a.post(f"/api/v1/carts/{order_cart['id']}/items", json={"product_id": product["id"]})
    order = client_a.post(f"/api/v1/carts/{order_cart['id']}/checkout", json={"method": "khata"}).json()
    open_cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{open_cart['id']}/items", json={"product_id": product["id"]})
    open_cart = client_a.get(f"/api/v1/carts/{open_cart['id']}").json()
    return {
        "category": category,
        "product": product,
        "customer": customer,
        "order": order,
        "cart": open_cart,
        "cart_item": open_cart["items"][0],
    }


def _assert_404(res):
    assert res.status_code == 404, f"{res.request.method} {res.request.url} -> {res.status_code} {res.text}"
    assert res.json()["error"]["code"] == "not_found"


def test_b_cannot_read_a_records(client_b, a_data):
    d = a_data
    for url in [
        f"/api/v1/products/{d['product']['id']}",
        f"/api/v1/customers/{d['customer']['id']}",
        f"/api/v1/customers/{d['customer']['id']}/khata",
        f"/api/v1/carts/{d['cart']['id']}",
        f"/api/v1/orders/{d['order']['id']}",
    ]:
        _assert_404(client_b.get(url))


def test_b_lists_never_include_a_records(client_b, a_data):
    create_product(client_b, name="B-Lays")
    create_customer(client_b, name="B-Priya", phone="7000000002")
    assert [p["name"] for p in client_b.get("/api/v1/products", params={"include_inactive": True}).json()] == ["B-Lays"]
    assert client_b.get("/api/v1/products", params={"barcode": "A-111"}).json() == []
    assert client_b.get("/api/v1/products", params={"q": "Kurkure"}).json() == []
    assert client_b.get("/api/v1/categories").json() == []
    assert [c["name"] for c in client_b.get("/api/v1/customers").json()] == ["B-Priya"]
    assert client_b.get("/api/v1/orders").json() == []
    assert client_b.get("/api/v1/orders", params={"customer_id": a_data["customer"]["id"]}).json() == []
    assert [b["customer_name"] for b in client_b.get("/api/v1/khata/balances").json()] == ["B-Priya"]


def test_b_cannot_modify_a_records(client_a, client_b, a_data):
    d = a_data
    pid, cid, cart_id = d["product"]["id"], d["customer"]["id"], d["cart"]["id"]
    _assert_404(client_b.patch(f"/api/v1/products/{pid}", json={"price": "0"}))
    _assert_404(client_b.delete(f"/api/v1/products/{pid}"))
    _assert_404(client_b.patch(f"/api/v1/categories/{d['category']['id']}", json={"name": "Hacked"}))
    _assert_404(client_b.delete(f"/api/v1/categories/{d['category']['id']}"))
    _assert_404(client_b.post("/api/v1/inventory/adjustments", json={"product_id": pid, "delta": "-1"}))
    _assert_404(client_b.patch(f"/api/v1/customers/{cid}", json={"name": "Hacked"}))
    _assert_404(client_b.delete(f"/api/v1/customers/{cid}"))
    _assert_404(client_b.post(f"/api/v1/customers/{cid}/khata/credits", json={"amount": "999"}))
    _assert_404(client_b.post(f"/api/v1/customers/{cid}/khata/payments", json={"amount": "999"}))
    _assert_404(client_b.patch(f"/api/v1/carts/{cart_id}", json={"customer_id": None}))
    _assert_404(client_b.post(f"/api/v1/carts/{cart_id}/items", json={"product_id": pid}))
    _assert_404(client_b.patch(f"/api/v1/carts/{cart_id}/items/{d['cart_item']['id']}", json={"quantity": "9"}))
    _assert_404(client_b.delete(f"/api/v1/carts/{cart_id}/items/{d['cart_item']['id']}"))
    _assert_404(client_b.post(f"/api/v1/carts/{cart_id}/checkout", json={"method": "cash"}))

    # A's data is untouched.
    product = client_a.get(f"/api/v1/products/{pid}").json()
    assert product["price"] == d["product"]["price"] and product["is_active"] is True
    assert product["stock_quantity"] == "9.000"  # only A's own sale
    assert client_a.get(f"/api/v1/customers/{cid}").json()["name"] == "A-Rahul"
    assert client_a.get(f"/api/v1/customers/{cid}/khata").json()["balance"] == "114.00"
    cart = client_a.get(f"/api/v1/carts/{cart_id}").json()
    assert cart["status"] == "open" and cart["items"][0]["quantity"] == "1.000"
    assert client_a.get("/api/v1/categories").json()[0]["name"] == "Snacks"


def test_b_cannot_reference_a_records_from_own_data(client_b, a_data):
    d = a_data
    own_cart = create_cart(client_b)
    _assert_404(client_b.post(f"/api/v1/carts/{own_cart['id']}/items", json={"product_id": d["product"]["id"]}))
    _assert_404(client_b.post(f"/api/v1/carts/{own_cart['id']}/items", json={"barcode": "A-111"}))
    _assert_404(client_b.patch(f"/api/v1/carts/{own_cart['id']}", json={"customer_id": d["customer"]["id"]}))
    _assert_404(client_b.post("/api/v1/carts", json={"customer_id": d["customer"]["id"]}))
    _assert_404(
        client_b.post("/api/v1/products", json={"name": "X", "price": "1", "category_id": d["category"]["id"]})
    )
    own = create_product(client_b, name="B-Item")
    _assert_404(client_b.patch(f"/api/v1/products/{own['id']}", json={"category_id": d["category"]["id"]}))


def test_same_business_keys_allowed_across_merchants(client_a, client_b):
    create_product(client_a, name="Maggi", barcode="890", sku="M1")
    create_product(client_b, name="Maggi", barcode="890", sku="M1")
    client_a.post("/api/v1/categories", json={"name": "Snacks"})
    assert client_b.post("/api/v1/categories", json={"name": "Snacks"}).status_code == 201


def test_random_ids_are_404(client_a):
    _assert_404(client_a.get(f"/api/v1/products/{uuid.uuid4()}"))
    _assert_404(client_a.get(f"/api/v1/orders/{uuid.uuid4()}"))


def test_assistant_tools_respect_tenant(client_a, client_b, a_data, db):
    """LLM tool calls go through services, so they inherit isolation."""
    me_b = client_b.get("/api/v1/auth/me").json()
    ctx_b = TenantContext(merchant_id=uuid.UUID(me_b["merchant"]["id"]), user_id=uuid.UUID(me_b["user"]["id"]))
    customer_a = a_data["customer"]["id"]

    with pytest.raises(NotFound):
        execute_tool(db, ctx_b, "get_customer_balance", {"customer_id": customer_a})
    with pytest.raises(NotFound):
        execute_tool(db, ctx_b, "record_khata_payment", {"customer_id": customer_a, "amount": "50"})
    with pytest.raises(NotFound):
        execute_tool(db, ctx_b, "add_to_cart", {"cart_id": a_data["cart"]["id"], "product_id": a_data["product"]["id"]})
    assert execute_tool(db, ctx_b, "search_products", {"query": "Kurkure"}) == []
