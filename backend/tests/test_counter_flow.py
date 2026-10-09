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


def test_stock_only_moves_at_checkout_never_while_the_bill_is_being_built(client_a, make_client):
    """The Counter shows "stock minus what is on the bill" on screen; the database is not touched until the sale."""
    atta = create_product(client_a, name="Atta 5kg", price="295.00", stock_quantity="15")
    cart = create_cart(client_a)

    line = _add(client_a, cart["id"], product_id=atta["id"], quantity="7")["items"][0]
    assert _stock(client_a, atta["id"]) == "15.000"
    client_a.patch(f"/api/v1/carts/{cart['id']}/items/{line['id']}", json={"quantity": "15"})
    assert _stock(client_a, atta["id"]) == "15.000"
    # Even a bill for more than there is does not move stock; it is refused whole at checkout.
    client_a.patch(f"/api/v1/carts/{cart['id']}/items/{line['id']}", json={"quantity": "16"})
    refused = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "insufficient_stock"
    assert _stock(client_a, atta["id"]) == "15.000"
    client_a.delete(f"/api/v1/carts/{cart['id']}/items/{line['id']}")
    assert _stock(client_a, atta["id"]) == "15.000"

    # A storefront order takes from the same stock, and the Counter's sale then sees what is left.
    shopper = make_client()
    placed = shopper.post("/api/v1/public/stores/store-a/orders", json={"items": [{"product_id": atta["id"], "quantity": "5"}]})
    assert placed.status_code == 201 and _stock(client_a, atta["id"]) == "10.000"
    _add(client_a, cart["id"], product_id=atta["id"], quantity="11")
    assert client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).status_code == 409
    line = client_a.get(f"/api/v1/carts/{cart['id']}").json()["items"][0]
    client_a.patch(f"/api/v1/carts/{cart['id']}/items/{line['id']}", json={"quantity": "3"})
    assert _stock(client_a, atta["id"]) == "10.000"
    _checkout(client_a, cart["id"], method="cash")
    assert _stock(client_a, atta["id"]) == "7.000"  # only the completed sale reduced it
