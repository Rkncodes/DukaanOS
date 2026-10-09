from decimal import Decimal

from sqlalchemy import select

from app.core.enums import InputSource
from app.core.tenancy import TenantContext
from app.integrations.types import RecognizedItem
from app.modules.auth import service as auth
from app.modules.auth.schemas import RegisterRequest
from app.modules.billing import service as billing
from app.modules.billing.schemas import CartCreate
from app.modules.catalog import service as catalog
from app.modules.catalog.schemas import ProductCreate
from app.modules.payments.models import Payment
from tests.conftest import create_cart, create_customer, create_product


def test_cart_add_update_remove(client_a):
    maggi = create_product(client_a, name="Maggi", price="14.00", barcode="111")
    coke = create_product(client_a, name="Coke", price="40.00", barcode="222")
    cart = create_cart(client_a)
    assert cart["status"] == "open" and cart["channel"] == "counter" and cart["items"] == []

    url = f"/api/v1/carts/{cart['id']}/items"
    cart = client_a.post(url, json={"product_id": maggi["id"], "quantity": "2"}).json()
    cart = client_a.post(url, json={"barcode": "222", "source": "barcode"}).json()
    cart = client_a.post(url, json={"product_id": maggi["id"], "quantity": "1", "source": "voice"}).json()

    lines = {i["product_name"]: i for i in cart["items"]}
    assert lines["Maggi"]["quantity"] == "3.000"  # merged into one line
    assert lines["Maggi"]["source"] == "manual"  # source of the first add
    assert lines["Coke"]["source"] == "barcode"
    assert cart["subtotal"] == "82.00"

    coke_line = lines["Coke"]["id"]
    cart = client_a.patch(f"{url}/{coke_line}", json={"quantity": "3"}).json()
    assert cart["subtotal"] == "162.00"
    cart = client_a.delete(f"{url}/{coke_line}").json()
    assert [i["product_name"] for i in cart["items"]] == ["Maggi"]
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["subtotal"] == "42.00"


def test_barcode_billing_is_an_exact_lookup_into_the_same_cart_and_bill(client_a, client_b):
    maggi = create_product(client_a, name="Maggi", price="14.00", barcode="8901058000017", stock_quantity="5")
    retired = create_product(client_a, name="Old Biscuit", price="10.00", barcode="8900000000999")
    client_a.delete(f"/api/v1/products/{retired['id']}")  # taken off sale
    create_product(client_b, name="B's Chips", price="20.00", barcode="8902222222222")
    rahul = create_customer(client_a, name="Rahul")
    cart = create_cart(client_a, customer_id=rahul["id"])
    url = f"/api/v1/carts/{cart['id']}/items"

    # A scan resolves the exact product at the catalogue's price; scanning again adds one more to the same line.
    first = client_a.post(url, json={"barcode": "8901058000017", "source": "barcode"})
    assert first.status_code == 200
    line = first.json()["items"][0]
    assert (line["product_id"], line["product_name"], line["unit_price"], line["quantity"], line["source"]) == (
        maggi["id"], "Maggi", "14.00", "1.000", "barcode",
    )  # fmt: skip
    again = client_a.post(url, json={"barcode": "8901058000017", "source": "barcode"}).json()
    assert [(i["product_name"], i["quantity"]) for i in again["items"]] == [("Maggi", "2.000")]

    # Nothing is guessed: a near miss, an off-sale product's code and another merchant's code are all unknown.
    for unknown in ("890105800001", "89010580000170", "0000000000000", "8900000000999", "8902222222222"):
        res = client_a.post(url, json={"barcode": unknown, "source": "barcode"})
        assert res.status_code == 404, unknown
        assert res.json()["error"] == {"code": "not_found", "message": f"Barcode not found: {unknown}", "details": None}
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["subtotal"] == "28.00"  # the bill did not change

    # The scanned line is an ordinary line: its quantity changes, stock is respected, and it checks out to khata.
    cart = client_a.patch(f"{url}/{line['id']}", json={"quantity": "6"}).json()
    short = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "khata"})
    assert short.status_code == 409 and short.json()["error"]["code"] == "insufficient_stock"
    client_a.patch(f"{url}/{line['id']}", json={"quantity": "5"})
    order = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "khata"}).json()
    assert order["total"] == "70.00" and order["payment_status"] == "credit"
    assert [(i["product_name"], i["source"]) for i in order["items"]] == [("Maggi", "barcode")]
    assert client_a.get(f"/api/v1/products/{maggi['id']}").json()["stock_quantity"] == "0.000"
    assert client_a.get(f"/api/v1/customers/{rahul['id']}/khata").json()["balance"] == "70.00"


def test_add_item_validation(client_a):
    product = create_product(client_a)
    cart = create_cart(client_a)
    url = f"/api/v1/carts/{cart['id']}/items"
    assert client_a.post(url, json={"product_id": product["id"], "barcode": "x"}).status_code == 422
    assert client_a.post(url, json={}).status_code == 422
    assert client_a.post(url, json={"product_id": product["id"], "quantity": "0"}).status_code == 422
    assert client_a.post(url, json={"product_id": product["id"], "source": "telepathy"}).status_code == 422
    assert client_a.post(url, json={"barcode": "does-not-exist"}).status_code == 404

    client_a.delete(f"/api/v1/products/{product['id']}")
    assert client_a.post(url, json={"product_id": product["id"]}).status_code == 422


def test_cash_checkout_creates_order_payment_and_decrements_stock(client_a, db):
    product = create_product(client_a, name="Parle-G", price="25.00", stock_quantity="10")
    cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"], "quantity": "4"})

    res = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash", "discount": "5"})
    assert res.status_code == 201, res.text
    order = res.json()
    assert (order["subtotal"], order["discount"], order["total"]) == ("100.00", "5.00", "95.00")
    assert order["status"] == "completed" and order["payment_status"] == "paid"
    assert order["channel"] == "counter"
    assert order["items"][0]["product_name"] == "Parle-G"
    assert order["items"][0]["line_total"] == "100.00"

    assert client_a.get(f"/api/v1/products/{product['id']}").json()["stock_quantity"] == "6.000"
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["status"] == "checked_out"
    assert client_a.get(f"/api/v1/orders/{order['id']}").json()["id"] == order["id"]
    assert [o["id"] for o in client_a.get("/api/v1/orders").json()] == [order["id"]]

    payment = db.scalar(select(Payment).where(Payment.order_id == order["id"]))
    assert payment.amount == Decimal("95.00") and payment.method == "cash" and payment.status == "succeeded"

    # Snapshot survives renames.
    client_a.patch(f"/api/v1/products/{product['id']}", json={"name": "Parle-G Gold"})
    assert client_a.get(f"/api/v1/orders/{order['id']}").json()["items"][0]["product_name"] == "Parle-G"


def test_khata_checkout_records_credit_not_payment(client_a, db):
    product = create_product(client_a, price="50.00")
    customer = create_customer(client_a)
    cart = create_cart(client_a)

    no_customer = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "khata"})
    assert no_customer.status_code == 422

    client_a.patch(f"/api/v1/carts/{cart['id']}", json={"customer_id": customer["id"]})
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"], "quantity": "2"})
    order = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "khata"}).json()
    assert order["payment_status"] == "credit" and order["customer_id"] == customer["id"]

    ledger = client_a.get(f"/api/v1/customers/{customer['id']}/khata").json()
    assert ledger["balance"] == "100.00"
    assert ledger["entries"][0]["order_id"] == order["id"]
    assert db.scalar(select(Payment).where(Payment.order_id == order["id"])) is None


def test_checkout_rules(client_a):
    product = create_product(client_a, price="10.00", stock_quantity="2")
    cart = create_cart(client_a)
    checkout = f"/api/v1/carts/{cart['id']}/checkout"
    assert client_a.post(checkout, json={"method": "cash"}).status_code == 422  # empty cart

    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"], "quantity": "1"})
    assert client_a.post(checkout, json={"method": "cash", "discount": "11"}).status_code == 422
    assert client_a.post(checkout, json={"method": "cash"}).status_code == 201
    assert client_a.post(checkout, json={"method": "cash"}).status_code == 409  # already checked out
    res = client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"]})
    assert res.status_code == 409  # cannot modify a checked-out cart


def test_insufficient_stock_rolls_back_whole_checkout(client_a):
    plenty = create_product(client_a, name="Plenty", stock_quantity="100")
    scarce = create_product(client_a, name="Scarce", stock_quantity="1")
    cart = create_cart(client_a)
    for pid in (plenty["id"], scarce["id"]):
        client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": pid, "quantity": "5"})

    res = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "insufficient_stock"
    assert client_a.get(f"/api/v1/products/{plenty['id']}").json()["stock_quantity"] == "100.000"
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["status"] == "open"
    assert client_a.get("/api/v1/orders").json() == []


def _sale(client, cart_id: str, product_id: str, qty: str = "1", method: str = "cash") -> dict:
    client.post(f"/api/v1/carts/{cart_id}/items", json={"product_id": product_id, "quantity": qty})
    res = client.post(f"/api/v1/carts/{cart_id}/checkout", json={"method": method})
    assert res.status_code == 201, res.text
    return res.json()


def test_cross_sell_ranks_by_co_purchase_frequency(client_a):
    maggi = create_product(client_a, name="Maggi", price="14.00", stock_quantity="50", barcode="1")
    coke = create_product(client_a, name="Coke", price="40.00", stock_quantity="50", barcode="2")
    chips = create_product(client_a, name="Chips", price="20.00", stock_quantity="50", barcode="3")
    unrelated = create_product(client_a, name="Unrelated", price="5.00", stock_quantity="50", barcode="4")

    # Maggi+Coke bought together twice; Maggi+Chips once; Unrelated never with Maggi.
    for _ in range(2):
        cart = create_cart(client_a)
        client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": maggi["id"]})
        client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": coke["id"]})
        client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})
    cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": maggi["id"]})
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": chips["id"]})
    client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})
    _sale(client_a, create_cart(client_a)["id"], unrelated["id"])

    live_cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{live_cart['id']}/items", json={"product_id": maggi["id"]})
    suggestions = client_a.get(f"/api/v1/carts/{live_cart['id']}/cross-sell").json()
    assert [(s["name"], s["times_bought_together"]) for s in suggestions] == [("Coke", 2), ("Chips", 1)]
    assert "Unrelated" not in [s["name"] for s in suggestions]


def test_cross_sell_excludes_items_already_in_cart_and_inactive_products(client_a):
    maggi = create_product(client_a, name="Maggi", price="14.00", stock_quantity="50", barcode="11")
    coke = create_product(client_a, name="Coke", price="40.00", stock_quantity="50", barcode="22")
    retired = create_product(client_a, name="Retired", price="10.00", stock_quantity="50", barcode="33")
    for product in (coke, retired):
        cart = create_cart(client_a)
        client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": maggi["id"]})
        client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"]})
        client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})
    client_a.delete(f"/api/v1/products/{retired['id']}")

    live_cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{live_cart['id']}/items", json={"product_id": maggi["id"]})
    client_a.post(f"/api/v1/carts/{live_cart['id']}/items", json={"product_id": coke["id"]})
    suggestions = client_a.get(f"/api/v1/carts/{live_cart['id']}/cross-sell").json()
    assert suggestions == []  # Coke already in cart, Retired no longer on sale


def test_cross_sell_is_empty_for_an_empty_cart(client_a):
    cart = create_cart(client_a)
    assert client_a.get(f"/api/v1/carts/{cart['id']}/cross-sell").json() == []


def test_cross_sell_is_isolated_per_merchant(client_a, client_b):
    maggi_a = create_product(client_a, name="Maggi", price="14.00", stock_quantity="50")
    coke_a = create_product(client_a, name="Coke", price="40.00", stock_quantity="50")
    cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": maggi_a["id"]})
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": coke_a["id"]})
    client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})

    maggi_b = create_product(client_b, name="Maggi", price="14.00", stock_quantity="50")
    live_cart_b = create_cart(client_b)
    client_b.post(f"/api/v1/carts/{live_cart_b['id']}/items", json={"product_id": maggi_b["id"]})
    assert client_b.get(f"/api/v1/carts/{live_cart_b['id']}/cross-sell").json() == []


def _merchant_ctx(db, email: str) -> TenantContext:
    user = auth.register(db, RegisterRequest(name="O", email=email, password="password123", store_name=email))
    return TenantContext(merchant_id=user.merchant_id, user_id=user.id)


def test_recognized_items_converge_on_billing_service(db):
    """Vision / Voice / Parchi adapters feed RecognizedItems into the same cart service."""
    ctx = _merchant_ctx(db, "conv-a@dukaanos.dev")
    other = _merchant_ctx(db, "conv-b@dukaanos.dev")
    maggi = catalog.create_product(db, ctx, ProductCreate(name="Maggi", price=Decimal(14), barcode="111"))
    coke = catalog.create_product(db, ctx, ProductCreate(name="Coke", price=Decimal(40)))
    foreign = catalog.create_product(db, other, ProductCreate(name="Foreign", price=Decimal(1), barcode="999"))
    cart = billing.create_cart(db, ctx, CartCreate())

    result = billing.add_recognized_items(
        db,
        ctx,
        cart.id,
        [
            RecognizedItem(source=InputSource.VISION, product_id=maggi.id),
            RecognizedItem(source=InputSource.BARCODE, barcode="111", quantity=Decimal(2)),
            RecognizedItem(source=InputSource.VOICE, name_hint="  coke "),
            RecognizedItem(source=InputSource.PARCHI, name_hint="Unknown thing"),
            RecognizedItem(source=InputSource.VISION, product_id=foreign.id),  # other merchant
            RecognizedItem(source=InputSource.BARCODE, barcode="999"),  # other merchant
        ],
    )
    lines = {item.product_id: item for item in result.cart.items}
    assert lines[maggi.id].quantity == 3 and lines[maggi.id].source == "vision"
    assert lines[coke.id].source == "voice"
    assert foreign.id not in lines
    assert [u.name_hint or u.barcode or u.product_id for u in result.unresolved] == [
        "Unknown thing",
        foreign.id,
        "999",
    ]
