"""The Counter vertical slice, end to end through the HTTP API:

    product (manual / barcode) -> cart -> checkout -> payment | khata -> inventory -> bill
"""

from tests.conftest import create_cart, create_customer, create_product


def _add(client, cart_id: str, **item) -> dict:
    res = client.post(f"/api/v1/carts/{cart_id}/items", json=item)
    assert res.status_code == 200, res.text
    return res.json()


def _checkout(client, cart_id: str, **body) -> dict:
    res = client.post(f"/api/v1/carts/{cart_id}/checkout", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _bill(client, order_id: str) -> dict:
    res = client.get(f"/api/v1/orders/{order_id}/bill")
    assert res.status_code == 200, res.text
    return res.json()


def _stock(client, product_id: str) -> str:
    return client.get(f"/api/v1/products/{product_id}").json()["stock_quantity"]


def test_cash_sale_with_manual_and_barcode_items(client_a):
    maggi = create_product(client_a, name="Maggi", price="14.00", stock_quantity="20")
    milk = create_product(client_a, name="Milk 500ml", price="30.00", stock_quantity="5", barcode="8901")
    cart = create_cart(client_a)

    _add(client_a, cart["id"], product_id=maggi["id"], quantity="2")
    cart = _add(client_a, cart["id"], barcode="8901", source="barcode")
    assert cart["subtotal"] == "58.00"

    order = _checkout(client_a, cart["id"], method="upi", discount="3")
    bill = _bill(client_a, order["id"])

    assert bill["order"]["total"] == "55.00" and bill["order"]["payment_status"] == "paid"
    assert {i["product_name"]: i["source"] for i in bill["order"]["items"]} == {
        "Maggi": "manual",
        "Milk 500ml": "barcode",
    }
    [payment] = bill["payments"]
    assert (payment["amount"], payment["method"], payment["status"]) == ("55.00", "upi", "succeeded")
    assert bill["khata_entry"] is None
    assert bill["customer"] is None and bill["customer_balance"] is None

    assert _stock(client_a, maggi["id"]) == "18.000"
    assert _stock(client_a, milk["id"]) == "4.000"


def test_khata_sale_links_bill_to_customer_ledger(client_a):
    atta = create_product(client_a, name="Atta 5kg", price="250.00", stock_quantity="4")
    customer = create_customer(client_a, name="Sunita")
    client_a.post(f"/api/v1/customers/{customer['id']}/khata/credits", json={"amount": "100.00"})

    cart = create_cart(client_a, customer_id=customer["id"])
    _add(client_a, cart["id"], product_id=atta["id"], quantity="2")
    order = _checkout(client_a, cart["id"], method="khata")
    bill = _bill(client_a, order["id"])

    assert bill["order"]["payment_status"] == "credit" and bill["order"]["status"] == "completed"
    assert bill["payments"] == []  # udhaar: no money received
    assert bill["customer"]["name"] == "Sunita"
    assert bill["khata_entry"]["amount"] == "500.00"
    assert bill["khata_entry"]["order_id"] == order["id"]
    assert bill["customer_balance"] == "600.00"  # previous 100 + this bill
    assert _stock(client_a, atta["id"]) == "2.000"


def test_cash_sale_to_known_customer_shows_their_balance(client_a):
    product = create_product(client_a, price="20.00")
    customer = create_customer(client_a)
    client_a.post(f"/api/v1/customers/{customer['id']}/khata/credits", json={"amount": "75.00"})

    cart = create_cart(client_a, customer_id=customer["id"])
    _add(client_a, cart["id"], product_id=product["id"])
    bill = _bill(client_a, _checkout(client_a, cart["id"], method="cash")["id"])

    assert bill["payments"][0]["customer_id"] == customer["id"]
    assert bill["khata_entry"] is None
    assert bill["customer_balance"] == "75.00"  # cash sale leaves udhaar unchanged


def test_bill_is_merchant_scoped(client_a, client_b):
    product = create_product(client_a)
    cart = create_cart(client_a)
    _add(client_a, cart["id"], product_id=product["id"])
    order = _checkout(client_a, cart["id"], method="cash")

    res = client_b.get(f"/api/v1/orders/{order['id']}/bill")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "not_found"
