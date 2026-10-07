"""Shop: the public storefront, order placement through the shared cart -> order pipeline, the
merchant's order lifecycle, stock, and merchant isolation.

Customers use a client without a session; merchants use client_a / client_b. Every product, price
and stock figure is created through the same API the Counter uses.
"""

import uuid

import pytest
from sqlalchemy import func, select

from app.modules.billing.models import Cart
from app.modules.customers.models import Customer
from app.modules.orders.models import Order
from app.modules.payments.models import Payment
from tests.conftest import create_cart, create_product

SLUG_A, SLUG_B = "store-a", "store-b"


def store(slug: str) -> str:
    return f"/api/v1/public/stores/{slug}"


@pytest.fixture
def customer(make_client):
    """A shopper: no account, no session cookie."""
    return make_client()


def _stock(client, product_id: str) -> str:
    return client.get(f"/api/v1/products/{product_id}").json()["stock_quantity"]


def _place(customer, slug: str, items: list[tuple[dict, str]], **extra):
    body = {"items": [{"product_id": p["id"], "quantity": q} for p, q in items]} | extra
    return customer.post(f"{store(slug)}/orders", json=body)


def _order(customer, client, *, quantity: str = "2", stock: str = "10") -> tuple[dict, dict]:
    """A product of store A (₹50) and a placed Shop order for `quantity` of it."""
    product = create_product(client, name="Tea 250g", price="50.00", stock_quantity=stock)
    res = _place(customer, SLUG_A, [(product, quantity)])
    assert res.status_code == 201, res.text
    return product, res.json()


def _move(client, order_id: str, status: str, **extra):
    return client.patch(f"/api/v1/orders/{order_id}/status", json={"status": status} | extra)


# ---- storefront ----


def test_the_storefront_is_public_and_shows_the_merchants_real_catalogue(client_a, customer):
    snacks = client_a.post("/api/v1/categories", json={"name": "Snacks"}).json()
    empty = client_a.post("/api/v1/categories", json={"name": "Stationery"}).json()
    chips = create_product(
        client_a, name="Masala Chips 90g", price="20.00", stock_quantity="12", category_id=snacks["id"],
        image_url="https://img.example/chips.png", cost_price="14.00", barcode="8901234567890", sku="CH-90",
    )  # fmt: skip
    milk = create_product(client_a, name="Milk 500ml", price="32.00", stock_quantity="0", unit="pkt")

    info = customer.get(store(SLUG_A))
    assert info.status_code == 200, info.text
    assert info.json() == {
        "store_name": "Store A",
        "store_slug": SLUG_A,
        "categories": [{"id": snacks["id"], "name": "Snacks"}],  # only categories with something on sale
    }
    assert empty["id"] not in info.text

    products = customer.get(f"{store(SLUG_A)}/products")
    assert products.status_code == 200
    assert products.json() == [
        {
            "id": chips["id"], "name": "Masala Chips 90g", "price": "20.00", "unit": "pcs",
            "image_url": "https://img.example/chips.png", "category_id": snacks["id"], "in_stock": True,
        },
        {
            "id": milk["id"], "name": "Milk 500ml", "price": "32.00", "unit": "pkt",
            "image_url": None, "category_id": None, "in_stock": False,
        },
    ]  # fmt: skip
    # The merchant's private figures never reach the public.
    for private in ("cost_price", "14.00", "barcode", "8901234567890", "sku", "CH-90", "stock_quantity", "merchant_id"):
        assert private not in products.text and private not in info.text


def test_search_and_category_filter(client_a, customer):
    snacks = client_a.post("/api/v1/categories", json={"name": "Snacks"}).json()
    create_product(client_a, name="Masala Chips 90g", price="20.00", category_id=snacks["id"])
    create_product(client_a, name="Milk 500ml", price="32.00")
    names = lambda **params: [p["name"] for p in customer.get(f"{store(SLUG_A)}/products", params=params).json()]  # noqa: E731
    assert names(q="chip") == ["Masala Chips 90g"]
    assert names(q="MILK") == ["Milk 500ml"]
    assert names(category_id=snacks["id"]) == ["Masala Chips 90g"]
    assert names(q="soap") == []


def test_inactive_products_and_other_stores_products_are_not_shown(client_a, client_b, customer):
    on_sale = create_product(client_a, name="Tea 250g", price="50.00")
    hidden = create_product(client_a, name="Old Stock Soap", price="10.00")
    client_a.patch(f"/api/v1/products/{hidden['id']}", json={"is_active": False})
    theirs = create_product(client_b, name="Sugar 1kg", price="45.00")

    assert [p["id"] for p in customer.get(f"{store(SLUG_A)}/products").json()] == [on_sale["id"]]
    assert [p["id"] for p in customer.get(f"{store(SLUG_B)}/products").json()] == [theirs["id"]]
    assert customer.get(store(SLUG_B)).json()["store_name"] == "Store B"


def test_an_unknown_store_is_not_found(client_a, customer):
    product = create_product(client_a)
    for res in (
        customer.get(store("no-such-store")),
        customer.get(f"{store('no-such-store')}/products"),
        _place(customer, "no-such-store", [(product, "1")]),
        customer.get(f"{store('no-such-store')}/orders/{uuid.uuid4()}"),
    ):
        assert res.status_code == 404 and res.json()["error"]["message"] == "Store not found"


# ---- placing an order ----


def test_a_customer_places_a_real_order_without_an_account(client_a, customer, db):
    tea = create_product(client_a, name="Tea 250g", price="50.00", stock_quantity="10")
    salt = create_product(client_a, name="Salt 1kg", price="28.00", stock_quantity="5")

    res = _place(customer, SLUG_A, [(tea, "2"), (salt, "1")], customer_name="  Sunita  ", customer_phone="98765 43210")
    assert res.status_code == 201, res.text
    order = res.json()
    assert (order["status"], order["payment_status"]) == ("pending", "unpaid")  # nothing is paid, nothing is faked
    assert (order["subtotal"], order["total"]) == ("128.00", "128.00")
    assert [(i["product_name"], i["quantity"], i["unit_price"], i["line_total"]) for i in order["items"]] == [
        ("Tea 250g", "2.000", "50.00", "100.00"),
        ("Salt 1kg", "1.000", "28.00", "28.00"),
    ]
    assert (order["customer_name"], order["customer_phone"]) == ("Sunita", "98765 43210")

    # It is an ordinary order of this merchant, on the shop channel, made from a cart like a Counter bill.
    [seen] = client_a.get("/api/v1/orders", params={"channel": "shop"}).json()
    assert (seen["id"], seen["channel"], seen["status"], seen["customer_id"]) == (order["id"], "shop", "pending", None)
    assert (seen["customer_name"], seen["customer_phone"], seen["total"]) == ("Sunita", "98765 43210", "128.00")
    cart = db.get(Cart, uuid.UUID(seen["cart_id"]))
    assert (cart.channel, cart.status) == ("shop", "checked_out")
    # Stock is taken when the order is placed; no money is recorded and no khata customer is created.
    assert (_stock(client_a, tea["id"]), _stock(client_a, salt["id"])) == ("8.000", "4.000")
    assert db.scalar(select(func.count()).select_from(Payment)) == 0
    assert db.scalar(select(func.count()).select_from(Customer)) == 0

    # The customer can follow their order; the session-less client needs nothing but its id.
    tracked = customer.get(f"{store(SLUG_A)}/orders/{order['id']}")
    same = lambda o: {k: v for k, v in o.items() if not k.endswith("_at")}  # noqa: E731 (timestamps differ only in zone)
    assert tracked.status_code == 200 and same(tracked.json()) == same(order)


def test_contact_details_are_optional_and_validated(client_a, customer):
    product = create_product(client_a, stock_quantity="10")
    anonymous = _place(customer, SLUG_A, [(product, "1")], customer_name="   ", customer_phone="")
    assert anonymous.status_code == 201
    assert (anonymous.json()["customer_name"], anonymous.json()["customer_phone"]) == (None, None)
    assert _place(customer, SLUG_A, [(product, "1")], customer_phone="call me maybe").status_code == 422
    assert _place(customer, SLUG_A, [(product, "1")], customer_name="x" * 121).status_code == 422


def test_prices_and_totals_sent_by_the_browser_are_ignored(client_a, customer):
    tea = create_product(client_a, name="Tea 250g", price="50.00", stock_quantity="10")
    tampered = {
        "items": [{"product_id": tea["id"], "quantity": "3", "price": "1.00", "unit_price": "1.00", "line_total": "3.00"}],
        "subtotal": "3.00",
        "total": "3.00",
        "payment_status": "paid",
        "status": "completed",
        "merchant_id": str(uuid.uuid4()),
    }
    order = customer.post(f"{store(SLUG_A)}/orders", json=tampered)
    assert order.status_code == 201, order.text
    assert (order.json()["total"], order.json()["items"][0]["unit_price"]) == ("150.00", "50.00")
    assert (order.json()["status"], order.json()["payment_status"]) == ("pending", "unpaid")

    # The price is read when the order is placed: a change in the catalogue applies to the next order.
    client_a.patch(f"/api/v1/products/{tea['id']}", json={"price": "55.00"})
    assert _place(customer, SLUG_A, [(tea, "1")]).json()["total"] == "55.00"


def test_an_order_is_refused_whole_when_any_line_cannot_be_sold(client_a, client_b, customer, db):
    tea = create_product(client_a, name="Tea 250g", price="50.00", stock_quantity="3")
    salt = create_product(client_a, name="Salt 1kg", price="28.00", stock_quantity="5")
    hidden = create_product(client_a, name="Old Stock Soap", price="10.00", stock_quantity="5")
    client_a.patch(f"/api/v1/products/{hidden['id']}", json={"is_active": False})
    theirs = create_product(client_b, name="Sugar 1kg", price="45.00", stock_quantity="5")

    short = _place(customer, SLUG_A, [(salt, "1"), (tea, "4")])
    assert short.status_code == 409 and short.json()["error"]["code"] == "insufficient_stock"
    assert short.json()["error"]["details"]["available"] == "3.000"
    assert _place(customer, SLUG_A, [(salt, "1"), (hidden, "1")]).status_code == 422  # switched off by the merchant
    assert _place(customer, SLUG_A, [(salt, "1"), (theirs, "1")]).status_code == 404  # another store's product
    assert _place(customer, SLUG_B, [(tea, "1")]).status_code == 404  # this store's product, ordered at another store

    for body in (
        {"items": []},
        {},
        {"items": [{"product_id": tea["id"], "quantity": "0"}]},
        {"items": [{"product_id": tea["id"], "quantity": "-1"}]},
        {"items": [{"product_id": tea["id"], "quantity": "1000"}]},
        {"items": [{"product_id": "not-an-id", "quantity": "1"}]},
        {"items": [{"product_id": tea["id"], "quantity": "1"}] * 51},
    ):
        assert customer.post(f"{store(SLUG_A)}/orders", json=body).status_code == 422, body

    # Nothing was ordered and no stock moved, in either store.
    assert db.scalar(select(func.count()).select_from(Order)) == 0
    assert (_stock(client_a, tea["id"]), _stock(client_a, salt["id"]), _stock(client_b, theirs["id"])) == (
        "3.000", "5.000", "5.000",
    )  # fmt: skip


def test_the_last_units_cannot_be_sold_twice_across_shop_and_counter(client_a, customer):
    tea = create_product(client_a, name="Tea 250g", price="50.00", stock_quantity="3")
    assert _place(customer, SLUG_A, [(tea, "2")]).status_code == 201
    assert _stock(client_a, tea["id"]) == "1.000"
    assert _place(customer, SLUG_A, [(tea, "2")]).status_code == 409  # a second shopper

    cart = create_cart(client_a)  # and the Counter sees the same stock
    line = client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": tea["id"], "quantity": "2"}).json()["items"][0]
    assert client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).status_code == 409
    client_a.patch(f"/api/v1/carts/{cart['id']}/items/{line['id']}", json={"quantity": "1"})
    counter_sale = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})
    assert counter_sale.status_code == 201 and counter_sale.json()["status"] == "completed"  # Counter is unchanged
    assert _stock(client_a, tea["id"]) == "0.000"
    assert customer.get(f"{store(SLUG_A)}/products").json()[0]["in_stock"] is False


def test_the_same_product_twice_in_one_order_is_one_line(client_a, customer):
    tea = create_product(client_a, name="Tea 250g", price="50.00", stock_quantity="10")
    order = _place(customer, SLUG_A, [(tea, "1"), (tea, "2")]).json()
    assert [(i["quantity"], i["line_total"]) for i in order["items"]] == [("3.000", "150.00")]
    assert _stock(client_a, tea["id"]) == "7.000"


# ---- the merchant's order lifecycle ----


def test_the_merchant_takes_an_order_from_pending_to_completed(client_a, customer, db):
    product, order = _order(customer, client_a)

    for status in ("confirmed", "ready"):
        res = _move(client_a, order["id"], status)
        assert res.status_code == 200 and (res.json()["status"], res.json()["payment_status"]) == (status, "unpaid")
        assert customer.get(f"{store(SLUG_A)}/orders/{order['id']}").json()["status"] == status  # the customer sees it

    # Handing over an unpaid order needs to know how it was paid; that goes through the existing payment service.
    unpaid = _move(client_a, order["id"], "completed")
    assert unpaid.status_code == 422 and "how the customer paid" in unpaid.json()["error"]["message"]
    assert _move(client_a, order["id"], "completed", payment_method="paytm").status_code == 422  # needs Paytm's own flow
    done = _move(client_a, order["id"], "completed", payment_method="upi")
    assert done.status_code == 200 and (done.json()["status"], done.json()["payment_status"]) == ("completed", "paid")

    bill = client_a.get(f"/api/v1/orders/{order['id']}/bill").json()
    [payment] = bill["payments"]
    assert (payment["amount"], payment["method"], payment["status"]) == ("100.00", "upi", "succeeded")
    assert _stock(client_a, product["id"]) == "8.000"  # taken once, when the order was placed
    assert db.scalar(select(func.count()).select_from(Payment)) == 1


@pytest.mark.parametrize(
    ("reached", "invalid"),
    [
        ([], ["ready", "completed", "pending"]),
        (["confirmed"], ["completed", "pending", "confirmed"]),
        (["confirmed", "ready"], ["confirmed", "pending", "ready"]),
        (["confirmed", "ready", "completed"], ["pending", "confirmed", "ready", "cancelled", "completed"]),
        (["cancelled"], ["pending", "confirmed", "ready", "completed", "cancelled"]),
    ],
)
def test_only_the_next_valid_step_is_allowed(client_a, customer, reached, invalid):
    product, order = _order(customer, client_a)
    for status in reached:
        assert _move(client_a, order["id"], status, payment_method="cash").status_code == 200
    current = reached[-1] if reached else "pending"

    for status in invalid:
        res = _move(client_a, order["id"], status, payment_method="cash")
        assert res.status_code == 409, (current, status)
        assert res.json()["error"]["message"] == f"An order that is {current} cannot become {status}"
    assert client_a.get(f"/api/v1/orders/{order['id']}").json()["status"] == current
    assert _move(client_a, order["id"], "shipped").status_code == 422  # not a status at all
    assert _move(client_a, order["id"], "").status_code == 422


@pytest.mark.parametrize("reached", [[], ["confirmed"], ["confirmed", "ready"]])
def test_rejecting_or_cancelling_returns_the_stock_once(client_a, customer, db, reached):
    product, order = _order(customer, client_a, quantity="4")
    for status in reached:
        _move(client_a, order["id"], status)
    assert _stock(client_a, product["id"]) == "6.000"

    cancelled = _move(client_a, order["id"], "cancelled")
    assert cancelled.status_code == 200
    assert (cancelled.json()["status"], cancelled.json()["payment_status"]) == ("cancelled", "unpaid")
    assert _stock(client_a, product["id"]) == "10.000"
    assert _move(client_a, order["id"], "cancelled").status_code == 409  # not returned a second time
    assert _stock(client_a, product["id"]) == "10.000"
    assert db.scalar(select(func.count()).select_from(Payment)) == 0
    assert customer.get(f"{store(SLUG_A)}/orders/{order['id']}").json()["status"] == "cancelled"


def test_a_counter_bill_is_complete_at_checkout_and_is_not_a_shop_order(client_a, customer):
    product = create_product(client_a, name="Tea 250g", price="50.00", stock_quantity="10")
    cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"]})
    bill = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).json()
    assert (bill["status"], bill["channel"], bill["customer_name"]) == ("completed", "counter", None)

    assert _move(client_a, bill["id"], "cancelled").status_code == 409  # a completed sale does not move
    assert _stock(client_a, product["id"]) == "9.000"
    assert customer.get(f"{store(SLUG_A)}/orders/{bill['id']}").status_code == 404  # not visible on the storefront

    _place(customer, SLUG_A, [(product, "1")])
    by_channel = lambda channel: [o["channel"] for o in client_a.get("/api/v1/orders", params={"channel": channel}).json()]  # noqa: E731
    assert (by_channel("shop"), by_channel("counter")) == (["shop"], ["counter"])
    assert len(client_a.get("/api/v1/orders").json()) == 2
    assert [o["status"] for o in client_a.get("/api/v1/orders", params={"status": "pending"}).json()] == ["pending"]


# ---- isolation ----


def test_merchant_order_routes_need_a_login(client_a, customer):
    product, order = _order(customer, client_a)
    assert customer.get("/api/v1/orders").status_code == 401
    assert customer.get(f"/api/v1/orders/{order['id']}").status_code == 401
    assert _move(customer, order["id"], "confirmed").status_code == 401
    assert customer.get("/api/v1/products").status_code == 401  # the merchant catalogue stays private
    assert client_a.get(f"/api/v1/orders/{order['id']}").json()["status"] == "pending"


def test_a_merchant_never_sees_or_moves_another_merchants_order(client_a, client_b, customer):
    product, order = _order(customer, client_a)

    assert client_b.get("/api/v1/orders").json() == []
    assert client_b.get("/api/v1/orders", params={"channel": "shop"}).json() == []
    assert client_b.get(f"/api/v1/orders/{order['id']}").status_code == 404
    assert client_b.get(f"/api/v1/orders/{order['id']}/bill").status_code == 404
    for status in ("confirmed", "cancelled"):
        assert _move(client_b, order["id"], status).status_code == 404
    # Nor through the other store's public address.
    assert customer.get(f"{store(SLUG_B)}/orders/{order['id']}").status_code == 404
    assert customer.get(f"{store(SLUG_A)}/orders/{uuid.uuid4()}").status_code == 404

    assert client_a.get(f"/api/v1/orders/{order['id']}").json()["status"] == "pending"
    assert _stock(client_a, product["id"]) == "8.000"
