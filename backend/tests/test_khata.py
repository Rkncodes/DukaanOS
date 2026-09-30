from decimal import Decimal

from app.modules.payments.models import Payment
from tests.conftest import create_customer


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


def test_khata_amount_validation(client_a):
    customer = create_customer(client_a)
    base = f"/api/v1/customers/{customer['id']}/khata"
    assert client_a.post(f"{base}/credits", json={"amount": "0"}).status_code == 422
    assert client_a.post(f"{base}/credits", json={"amount": "-5"}).status_code == 422
    assert client_a.post(f"{base}/credits", json={"amount": "1.234"}).status_code == 422
    assert client_a.post(f"{base}/payments", json={"amount": "10", "method": "khata"}).status_code == 422
