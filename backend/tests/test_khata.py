import uuid
from decimal import Decimal

from app.modules.payments.models import Payment
from tests.conftest import create_cart, create_customer, create_product


def test_khata_credit_payment_and_balance(client_a, db):
    rahul = create_customer(client_a, name="Rahul", phone="1")
    base = f"/api/v1/customers/{rahul['id']}/khata"

    credit = client_a.post(f"{base}/credits", json={"amount": "450", "description": "Purana hisaab"})
    assert credit.status_code == 201
    assert credit.json()["type"] == "credit" and credit.json()["payment_id"] is None

    payment = client_a.post(f"{base}/payments", json={"amount": "200", "method": "upi", "source": "voice"})
    assert payment.status_code == 201
    entry = payment.json()
    assert entry["type"] == "payment" and entry["source"] == "voice"
    recorded = db.get(Payment, entry["payment_id"])
    assert recorded.amount == Decimal("200.00") and recorded.method == "upi"
    assert str(recorded.customer_id) == rahul["id"] and recorded.order_id is None

    ledger = client_a.get(base).json()
    assert ledger["balance"] == "250.00"
    assert ledger["customer"]["name"] == "Rahul"
    assert [e["type"] for e in ledger["entries"]] == ["payment", "credit"]  # newest first


def test_balances_list(client_a):
    rahul = create_customer(client_a, name="Rahul", phone="1")
    priya = create_customer(client_a, name="Priya", phone="2")
    neha = create_customer(client_a, name="Neha", phone="3")
    client_a.post(f"/api/v1/customers/{rahul['id']}/khata/credits", json={"amount": "100"})
    client_a.post(f"/api/v1/customers/{priya['id']}/khata/credits", json={"amount": "300"})
    client_a.post(f"/api/v1/customers/{priya['id']}/khata/payments", json={"amount": "50"})

    balances = client_a.get("/api/v1/khata/balances").json()
    assert [(b["customer_name"], b["balance"]) for b in balances] == [
        ("Priya", "250.00"),
        ("Rahul", "100.00"),
        ("Neha", "0.00"),
    ]
    assert balances[2]["last_entry_at"] is None
    outstanding = client_a.get("/api/v1/khata/balances", params={"outstanding_only": True}).json()
    assert {b["customer_id"] for b in outstanding} == {rahul["id"], priya["id"]}
    assert neha["id"] not in {b["customer_id"] for b in outstanding}


def test_overpayment_shows_as_advance(client_a):
    customer = create_customer(client_a)
    client_a.post(f"/api/v1/customers/{customer['id']}/khata/payments", json={"amount": "100"})
    assert client_a.get(f"/api/v1/customers/{customer['id']}/khata").json()["balance"] == "-100.00"


def test_ledger_is_newest_first_with_the_balance_after_each_entry(client_a):
    """Rahul takes 850 on udhaar and pays back 500: 350 is outstanding."""
    rahul = create_customer(client_a, name="Rahul")
    base = f"/api/v1/customers/{rahul['id']}/khata"
    empty = client_a.get(base).json()
    assert empty["balance"] == "0.00" and empty["entries"] == []

    client_a.post(f"{base}/credits", json={"amount": "550"})
    client_a.post(f"{base}/credits", json={"amount": "300", "description": "Atta, dal"})
    assert client_a.get(base).json()["balance"] == "850.00"
    client_a.post(f"{base}/payments", json={"amount": "500"})

    ledger = client_a.get(base).json()
    assert ledger["balance"] == "350.00"
    assert [(e["type"], e["amount"], e["balance_after"]) for e in ledger["entries"]] == [
        ("payment", "500.00", "350.00"),
        ("credit", "300.00", "850.00"),
        ("credit", "550.00", "550.00"),
    ]
    assert ledger["entries"][1]["description"] == "Atta, dal"
    created = [e["created_at"] for e in ledger["entries"]]
    assert created == sorted(created, reverse=True)
    # The newest entry's running balance is the outstanding balance, here and in the customer list.
    assert ledger["entries"][0]["balance_after"] == ledger["balance"]
    assert client_a.get("/api/v1/khata/balances").json()[0]["balance"] == "350.00"


def test_a_counter_bill_put_on_khata_is_an_entry_in_the_same_ledger(client_a):
    rahul = create_customer(client_a, name="Rahul")
    base = f"/api/v1/customers/{rahul['id']}/khata"
    client_a.post(f"{base}/credits", json={"amount": "100"})
    product = create_product(client_a, name="Maggi", price="14.00")
    cart = create_cart(client_a, customer_id=rahul["id"])
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"], "quantity": "3"})
    order = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "khata"}).json()
    bill = client_a.get(f"/api/v1/orders/{order['id']}/bill").json()

    ledger = client_a.get(base).json()
    assert ledger["balance"] == "142.00" == bill["customer_balance"]
    newest = ledger["entries"][0]
    assert (newest["type"], newest["amount"], newest["balance_after"]) == ("credit", "42.00", "142.00")
    assert newest["order_id"] == bill["order"]["id"] and newest["id"] == bill["khata_entry"]["id"]

    # A bill paid in cash for the same customer is money received, not udhaar: the ledger is unchanged.
    cart = create_cart(client_a, customer_id=rahul["id"])
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"]})
    assert client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).status_code == 201
    assert client_a.get(base).json()["balance"] == "142.00"


def test_khata_needs_a_real_customer_of_this_merchant(client_a, client_b, make_client):
    missing = f"/api/v1/customers/{uuid.uuid4()}/khata"
    assert client_a.get(missing).status_code == 404
    assert client_a.post(f"{missing}/credits", json={"amount": "10"}).status_code == 404
    assert client_a.post(f"{missing}/payments", json={"amount": "10"}).status_code == 404
    assert client_a.get("/api/v1/customers/not-a-uuid/khata").status_code == 422

    rahul = create_customer(client_a, name="Rahul")
    base = f"/api/v1/customers/{rahul['id']}/khata"
    client_a.post(f"{base}/credits", json={"amount": "850"})

    # Another merchant: the customer does not exist for them, and nothing is written.
    assert client_b.get(base).status_code == 404
    assert client_b.post(f"{base}/credits", json={"amount": "10"}).status_code == 404
    assert client_b.post(f"{base}/payments", json={"amount": "10"}).status_code == 404
    assert client_b.get("/api/v1/khata/balances").json() == []

    # Nobody logged in.
    anonymous = make_client()
    for res in (
        anonymous.get("/api/v1/khata/balances"),
        anonymous.get(base),
        anonymous.post(f"{base}/credits", json={"amount": "10"}),
        anonymous.post(f"{base}/payments", json={"amount": "10"}),
    ):
        assert res.status_code == 401
        assert res.json()["error"]["code"] == "unauthorized"

    ledger = client_a.get(base).json()
    assert ledger["balance"] == "850.00" and len(ledger["entries"]) == 1


def test_khata_amount_validation(client_a):
    customer = create_customer(client_a)
    base = f"/api/v1/customers/{customer['id']}/khata"
    assert client_a.post(f"{base}/credits", json={"amount": "0"}).status_code == 422
    assert client_a.post(f"{base}/credits", json={"amount": "-5"}).status_code == 422
    assert client_a.post(f"{base}/credits", json={"amount": "1.234"}).status_code == 422
    assert client_a.post(f"{base}/payments", json={"amount": "10", "method": "khata"}).status_code == 422
    assert client_a.post(f"{base}/payments", json={"amount": "0"}).status_code == 422
    assert client_a.post(f"{base}/payments", json={"amount": "-5"}).status_code == 422
    assert client_a.post(f"{base}/payments", json={}).status_code == 422
    assert client_a.post(f"{base}/credits", json={"amount": "abc"}).status_code == 422
    # Paytm money is only ever recorded after Paytm verifies it, never by naming the method.
    assert client_a.post(f"{base}/payments", json={"amount": "10", "method": "paytm"}).status_code == 422
    # Nothing refused was written.
    ledger = client_a.get(base).json()
    assert ledger["balance"] == "0.00" and ledger["entries"] == []
