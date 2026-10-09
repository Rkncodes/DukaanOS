"""Paytm payment of a Counter bill: server-side amount, server-side verification, a bill that is
completed exactly once, and merchant isolation.

Paytm itself is replaced at its boundary: FakePaytm stands in for the client in the API tests, and
the real HttpPaytmClient is exercised against an httpx MockTransport. No test talks to Paytm, and
none needs Paytm credentials. What happens to the bill is always decided by the code under test.
"""

import json
from decimal import Decimal

import httpx
import pytest
from paytmchecksum import generateSignature, verifySignature
from sqlalchemy import func, select

from app.core.config import Settings, settings
from app.integrations.paytm import (
    HOSTS,
    NO_RECORD_FOUND,
    PENDING,
    TXN_FAILURE,
    TXN_SUCCESS,
    HttpPaytmClient,
    PaytmConfig,
    PaytmError,
    PaytmRejected,
    PaytmTransaction,
)
from app.main import app
from app.modules.orders.models import Order
from app.modules.payments import paytm as paytm_service
from app.modules.payments.models import Payment, PaytmPayment
from app.modules.payments.router import get_paytm
from tests.conftest import create_cart, create_customer, create_product

START = "/api/v1/payments/paytm"
KEY = "0123456789abcdef"  # a made-up 16-character merchant key: never a real credential
CONFIG = PaytmConfig(
    environment="sandbox", host=HOSTS["sandbox"], mid="TESTMID0000000000001", merchant_key=KEY, website="WEBSTAGING"
)


class FakePaytm:
    """Test double for Paytm's side: records what it was asked and answers what the test tells it to."""

    def __init__(self):
        self.initiated: list[tuple[str, Decimal, str]] = []
        self.status_calls = 0
        self.answer: PaytmTransaction | Exception = PaytmTransaction(NO_RECORD_FOUND, "331", "No Record Found")
        self.initiate_error: Exception | None = None

    def initiate(self, *, order_id: str, amount: Decimal, customer_id: str) -> str:
        if self.initiate_error:
            raise self.initiate_error
        self.initiated.append((order_id, amount, customer_id))
        return f"token-for-{order_id}"

    def status(self, order_id: str) -> PaytmTransaction:
        self.status_calls += 1
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer

    def says(self, status: str, payment: dict | None = None, **fields) -> None:
        """What Paytm will answer from now on. For a success, `payment` supplies the order it is about."""
        base = {}
        if payment is not None:
            base = {
                "order_id": payment["paytm_order_id"],
                "mid": CONFIG.mid,
                "amount": Decimal(payment["amount"]),
                "txn_id": "20261003111212800110168470101509706",
                "bank_txn_id": "777001234215242",
                "payment_mode": "UPI",
                "signature_valid": True,
            }
        code, msg = {
            TXN_SUCCESS: ("01", "Txn Success"),
            TXN_FAILURE: ("227", "Your payment has been declined by your bank."),
            PENDING: ("402", "Looks like the payment is not complete."),
            NO_RECORD_FOUND: ("331", "No Record Found"),
        }[status]
        self.answer = PaytmTransaction(status, **({"result_code": code, "result_msg": msg} | base | fields))


@pytest.fixture
def paytm(make_client) -> FakePaytm:
    fake = FakePaytm()
    app.dependency_overrides[get_paytm] = lambda: paytm_service.Paytm(CONFIG, fake)  # cleared by make_client
    return fake


def _bill(client, *, quantity: str = "2", stock: str = "10") -> tuple[dict, dict]:
    """A product (₹50) and an open cart holding `quantity` of it."""
    product = create_product(client, name="Tea 250g", price="50.00", stock_quantity=stock)
    cart = create_cart(client)
    res = client.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": product["id"], "quantity": quantity})
    assert res.status_code == 200, res.text
    return product, res.json()


def _start(client, cart_id: str, **body) -> dict:
    res = client.post(START, json={"cart_id": cart_id} | body)
    assert res.status_code == 200, res.text
    return res.json()


def _verify(client, payment_id: str):
    return client.post(f"{START}/{payment_id}/verify")


def _cancel(client, payment_id: str):
    return client.post(f"{START}/{payment_id}/cancel")


def _stock(client, product_id: str) -> str:
    return client.get(f"/api/v1/products/{product_id}").json()["stock_quantity"]


def _adjust(client, product_id: str, delta: str) -> None:
    res = client.post("/api/v1/inventory/adjustments", json={"product_id": product_id, "delta": delta})
    assert res.status_code == 200, res.text


def _cart(client, cart_id: str) -> dict:
    return client.get(f"/api/v1/carts/{cart_id}").json()


def _orders(client) -> list[dict]:
    return client.get("/api/v1/orders").json()


# ---- configuration ----


def test_paytm_is_off_by_default_and_needs_credentials_when_switched_on():
    off = Settings(_env_file=None)
    assert (off.paytm_enabled, off.paytm_env, off.paytm) == (False, "sandbox", None)

    with pytest.raises(ValueError, match="PAYTM_ENABLED=true needs PAYTM_MID and PAYTM_MERCHANT_KEY"):
        Settings(_env_file=None, paytm_enabled=True)
    with pytest.raises(ValueError, match="needs PAYTM_MERCHANT_KEY"):
        Settings(_env_file=None, paytm_enabled=True, paytm_mid="MID1", paytm_merchant_key="  ")
    with pytest.raises(ValueError, match="needs PAYTM_MID"):
        Settings(_env_file=None, paytm_enabled=True, paytm_merchant_key=KEY)

    on = Settings(_env_file=None, paytm_enabled=True, paytm_mid="MID1", paytm_merchant_key=KEY)
    assert (on.paytm.environment, on.paytm.host, on.paytm.website) == (
        "sandbox",
        "https://securestage.paytmpayments.com",
        "WEBSTAGING",
    )
    assert KEY not in repr(on) and KEY not in repr(on.paytm)  # the key is not printed with the settings


def test_production_paytm_is_never_a_default_and_needs_a_production_deployment():
    with pytest.raises(ValueError, match="only allowed with ENV=prod"):
        Settings(_env_file=None, paytm_enabled=True, paytm_mid="MID1", paytm_merchant_key=KEY, paytm_env="production")
    live = Settings(
        _env_file=None, env="prod", jwt_secret="x" * 40, paytm_enabled=True, paytm_mid="MID1",
        paytm_merchant_key=KEY, paytm_env="production",
    )  # fmt: skip
    assert (live.paytm.host, live.paytm.website) == ("https://secure.paytmpayments.com", "DEFAULT")
    with pytest.raises(ValueError):
        Settings(_env_file=None, paytm_env="live")


def test_without_paytm_the_counter_still_works_and_paytm_says_it_is_not_set_up(client_a, monkeypatch):
    monkeypatch.setattr(settings, "paytm_enabled", False)
    product, cart = _bill(client_a)
    assert client_a.get(f"{START}/config").json() == {"enabled": False, "environment": None}

    res = client_a.post(START, json={"cart_id": cart["id"]})
    assert res.status_code == 503 and res.json()["error"]["code"] == "paytm_unavailable"
    assert "PAYTM_ENABLED=false" in res.json()["error"]["message"]

    order = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})  # cash is unaffected
    assert order.status_code == 201 and order.json()["payment_status"] == "paid"
    assert _stock(client_a, product["id"]) == "8.000"


def test_config_reports_the_environment_but_no_credentials(client_a, make_client, monkeypatch):
    for name, value in (("paytm_enabled", True), ("paytm_mid", "MID1"), ("paytm_merchant_key", Settings(_env_file=None, paytm_merchant_key=KEY).paytm_merchant_key)):  # fmt: skip
        monkeypatch.setattr(settings, name, value)
    res = client_a.get(f"{START}/config")
    assert res.json() == {"enabled": True, "environment": "sandbox"} and KEY not in res.text
    assert make_client().get(f"{START}/config").status_code == 401


# ---- starting a payment ----


def test_the_amount_sent_to_paytm_is_the_backends_bill_total_not_the_browsers(client_a, paytm):
    product, cart = _bill(client_a, quantity="3")  # 3 × ₹50
    # A tampered request: the browser claims the bill is ₹1.
    res = client_a.post(START, json={"cart_id": cart["id"], "discount": "20.00", "amount": "1.00", "txnAmount": "1.00"})
    assert res.status_code == 200, res.text
    body = res.json()

    [(order_id, amount, customer)] = paytm.initiated
    assert amount == Decimal("130.00")  # 150 - 20, computed from the cart
    assert order_id == body["payment"]["paytm_order_id"] and order_id.startswith("DKN") and len(order_id) <= 50
    assert customer.startswith("COUNTER_")
    assert body["checkout"] == {
        "host": "https://securestage.paytmpayments.com",
        "mid": CONFIG.mid,
        "order_id": order_id,
        "txn_token": f"token-for-{order_id}",
        "amount": "130.00",
    }
    payment = body["payment"]
    assert (payment["status"], payment["amount"], payment["discount"], payment["environment"]) == (
        "pending", "130.00", "20.00", "sandbox",
    )  # fmt: skip
    assert payment["order_id"] is None and payment["txn_id"] is None and payment["verified_at"] is None
    assert KEY not in res.text and "merchant_key" not in res.text  # no secret reaches the browser

    # Starting a payment sells nothing: the bill is open, stock untouched, no order, no money recorded.
    assert _cart(client_a, cart["id"])["status"] == "open"
    assert _stock(client_a, product["id"]) == "10.000" and _orders(client_a) == []
    assert client_a.get(f"{START}/current", params={"cart_id": cart["id"]}).json()["id"] == payment["id"]


def test_a_customer_on_the_bill_is_the_paytm_customer(client_a, paytm):
    _, cart = _bill(client_a)
    customer = create_customer(client_a, name="Sunita")
    client_a.patch(f"/api/v1/carts/{cart['id']}", json={"customer_id": customer["id"]})
    _start(client_a, cart["id"])
    assert paytm.initiated[0][2] == "CUST_" + customer["id"].replace("-", "")


def test_a_bill_that_cannot_be_sold_is_refused_before_paytm_is_asked(client_a, client_b, make_client, paytm):
    assert make_client().post(START, json={"cart_id": create_cart(client_a)["id"]}).status_code == 401
    assert client_a.post(START, json={}).status_code == 422

    empty = create_cart(client_a)
    res = client_a.post(START, json={"cart_id": empty["id"]})
    assert res.status_code == 422 and res.json()["error"]["message"] == "Cart is empty"

    product, cart = _bill(client_a)  # ₹100
    assert client_a.post(START, json={"cart_id": cart["id"], "discount": "100.01"}).status_code == 422
    assert client_a.post(START, json={"cart_id": cart["id"], "discount": "-1"}).status_code == 422
    free = client_a.post(START, json={"cart_id": cart["id"], "discount": "100.00"})
    assert free.status_code == 422 and "nothing to collect" in free.json()["error"]["message"]

    assert client_b.post(START, json={"cart_id": cart["id"]}).status_code == 404  # another merchant's bill

    _adjust(client_a, product["id"], "-9")  # 1 left, 2 on the bill
    short = client_a.post(START, json={"cart_id": cart["id"]})
    assert short.status_code == 409 and short.json()["error"]["code"] == "insufficient_stock"

    assert paytm.initiated == []  # Paytm was never involved


def test_a_completed_bill_cannot_be_paid_again(client_a, paytm):
    _, cart = _bill(client_a)
    assert client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).status_code == 201
    res = client_a.post(START, json={"cart_id": cart["id"]})
    assert res.status_code == 409 and res.json()["error"]["message"] == "Cart is checked_out"
    assert paytm.initiated == []


def test_pay_pressed_twice_or_after_a_refresh_continues_the_same_payment(client_a, paytm, db):
    _, cart = _bill(client_a)
    first = _start(client_a, cart["id"])
    again = _start(client_a, cart["id"])
    assert again["payment"]["id"] == first["payment"]["id"]
    assert [call[0] for call in paytm.initiated] == [first["payment"]["paytm_order_id"]] * 2  # the same Paytm order
    assert db.scalar(select(func.count()).select_from(PaytmPayment)) == 1

    # The bill changed while a payment is in flight: no second payment for a different amount.
    other = create_product(client_a, name="Sugar 1kg", price="45.00", stock_quantity="5")
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": other["id"]})
    res = client_a.post(START, json={"cart_id": cart["id"]})
    assert res.status_code == 409 and "already in progress" in res.json()["error"]["message"]
    assert res.json()["error"]["details"] == {"payment_id": first["payment"]["id"]}
    assert db.scalar(select(func.count()).select_from(PaytmPayment)) == 1


def test_when_paytm_refuses_or_cannot_be_reached_no_payment_is_left_behind(client_a, paytm, db):
    product, cart = _bill(client_a)
    paytm.initiate_error = PaytmRejected("2005", "Checksum provided is invalid")
    res = client_a.post(START, json={"cart_id": cart["id"]})
    assert res.status_code == 502 and res.json()["error"]["code"] == "paytm_failed"
    assert "Checksum provided is invalid" in res.json()["error"]["message"]
    assert res.json()["error"]["details"] == {"paytm_code": "2005"}

    paytm.initiate_error = PaytmError("Paytm did not answer in time")
    res = client_a.post(START, json={"cart_id": cart["id"]})
    assert res.status_code == 502 and "Nothing was charged" in res.json()["error"]["message"]

    assert db.scalar(select(func.count()).select_from(PaytmPayment)) == 0
    assert client_a.get(f"{START}/current", params={"cart_id": cart["id"]}).json() is None
    assert _cart(client_a, cart["id"])["status"] == "open" and _stock(client_a, product["id"]) == "10.000"


# ---- verification ----


def test_a_verified_payment_completes_the_bill_exactly_once(client_a, paytm, db):
    product, cart = _bill(client_a, quantity="3")
    payment = _start(client_a, cart["id"], discount="20")["payment"]
    paytm.says(TXN_SUCCESS, payment)

    res = _verify(client_a, payment["id"])
    assert res.status_code == 200, res.text
    paid = res.json()
    assert (paid["status"], paid["amount"], paid["payment_mode"]) == ("paid", "130.00", "UPI")
    assert paid["txn_id"] == "20261003111212800110168470101509706" and paid["bank_txn_id"] == "777001234215242"
    assert paid["verified_at"] is not None and paid["detail"] is None and paid["order_id"] is not None
    assert KEY not in res.text

    # The existing checkout made the sale: order, stock, money record, closed cart.
    bill = client_a.get(f"/api/v1/orders/{paid['order_id']}/bill").json()
    assert (bill["order"]["status"], bill["order"]["payment_status"]) == ("completed", "paid")
    assert (bill["order"]["subtotal"], bill["order"]["discount"], bill["order"]["total"]) == ("150.00", "20.00", "130.00")
    assert bill["order"]["cart_id"] == cart["id"]
    [money] = bill["payments"]
    assert (money["amount"], money["method"], money["status"], money["provider"]) == ("130.00", "paytm", "succeeded", "paytm")
    assert money["external_reference"] == paid["txn_id"]
    assert _stock(client_a, product["id"]) == "7.000"
    assert _cart(client_a, cart["id"])["status"] == "checked_out"
    assert client_a.get(f"{START}/current", params={"cart_id": cart["id"]}).json() is None


def test_verifying_or_cancelling_again_never_sells_or_deducts_twice(client_a, paytm, db):
    product, cart = _bill(client_a)
    payment = _start(client_a, cart["id"])["payment"]
    paytm.says(TXN_SUCCESS, payment)

    first = _verify(client_a, payment["id"]).json()
    asked = paytm.status_calls
    for repeat in (_verify, _verify, _cancel):  # a duplicate callback, a retry, a stale cancel
        res = repeat(client_a, payment["id"])
        assert res.status_code == 200 and res.json()["status"] == "paid"
        assert res.json()["order_id"] == first["order_id"]
    assert paytm.status_calls == asked  # a paid bill does not need Paytm again

    assert len(_orders(client_a)) == 1 and _stock(client_a, product["id"]) == "8.000"
    assert db.scalar(select(func.count()).select_from(Order)) == 1
    assert db.scalar(select(func.count()).select_from(Payment)) == 1
    again = client_a.post(START, json={"cart_id": cart["id"]})  # and the bill cannot be paid a second time
    assert again.status_code == 409


def test_a_failed_payment_sells_nothing_and_can_be_tried_again(client_a, paytm):
    product, cart = _bill(client_a)
    payment = _start(client_a, cart["id"])["payment"]
    paytm.says(TXN_FAILURE)

    failed = _verify(client_a, payment["id"]).json()
    assert (failed["status"], failed["result_code"], failed["order_id"]) == ("failed", "227", None)
    assert "declined by your bank" in failed["result_msg"]
    assert _orders(client_a) == [] and _stock(client_a, product["id"]) == "10.000"
    assert _cart(client_a, cart["id"])["status"] == "open"

    retry = _start(client_a, cart["id"])["payment"]  # a new attempt is a new Paytm order
    assert retry["id"] != payment["id"] and retry["paytm_order_id"] != payment["paytm_order_id"]
    paytm.says(TXN_SUCCESS, retry)
    assert _verify(client_a, retry["id"]).json()["status"] == "paid"
    assert len(_orders(client_a)) == 1 and _stock(client_a, product["id"]) == "8.000"


@pytest.mark.parametrize(
    ("status", "fields"),
    [
        (PENDING, {}),  # the bank has not confirmed yet
        (NO_RECORD_FOUND, {}),  # the customer has not paid yet
        (TXN_FAILURE, {"result_code": "334", "result_msg": "Invalid Order ID"}),  # Paytm has no transaction for the order
    ],
)
def test_a_payment_paytm_has_not_settled_stays_pending(client_a, paytm, status, fields):
    product, cart = _bill(client_a)
    payment = _start(client_a, cart["id"])["payment"]
    paytm.says(status, **fields)

    for _ in range(2):
        res = _verify(client_a, payment["id"])
        assert res.status_code == 200 and (res.json()["status"], res.json()["order_id"]) == ("pending", None)
    assert _orders(client_a) == [] and _stock(client_a, product["id"]) == "10.000"

    paytm.says(TXN_SUCCESS, payment)  # checking again later picks the success up
    assert _verify(client_a, payment["id"]).json()["status"] == "paid"


def test_cancelling_asks_paytm_first(client_a, paytm):
    product, cart = _bill(client_a)

    # Nothing was paid: cancelled, the bill stays open and a new payment can start.
    payment = _start(client_a, cart["id"])["payment"]
    cancelled = _cancel(client_a, payment["id"])
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    assert _cancel(client_a, payment["id"]).json()["status"] == "cancelled"  # idempotent
    assert _orders(client_a) == [] and _cart(client_a, cart["id"])["status"] == "open"
    assert client_a.get(f"{START}/current", params={"cart_id": cart["id"]}).json() is None

    # The bank is still deciding: it cannot be cancelled away.
    payment = _start(client_a, cart["id"])["payment"]
    paytm.says(PENDING)
    stuck = _cancel(client_a, payment["id"])
    assert stuck.status_code == 409 and "still confirming" in stuck.json()["error"]["message"]
    assert client_a.get(f"{START}/current", params={"cart_id": cart["id"]}).json()["status"] == "pending"

    # The money had in fact arrived: the bill is completed instead of cancelled.
    paytm.says(TXN_SUCCESS, payment)
    done = _cancel(client_a, payment["id"]).json()
    assert done["status"] == "paid" and done["order_id"] is not None
    assert _stock(client_a, product["id"]) == "8.000"


def test_an_amount_paytm_reports_that_is_not_the_bill_is_never_a_paid_bill(client_a, paytm):
    product, cart = _bill(client_a)  # ₹100
    payment = _start(client_a, cart["id"])["payment"]
    paytm.says(TXN_SUCCESS, payment, amount=Decimal("1.00"))

    res = _verify(client_a, payment["id"]).json()
    assert (res["status"], res["order_id"]) == ("needs_review", None)
    assert res["detail"] == "Paytm received ₹1.00 but the bill is ₹100.00. The bill was not completed."
    assert _orders(client_a) == [] and _stock(client_a, product["id"]) == "10.000"
    assert _cart(client_a, cart["id"])["status"] == "open"
    # Money is on record for this bill: no second Paytm payment is started on top of it.
    again = client_a.post(START, json={"cart_id": cart["id"]})
    assert again.status_code == 409 and "already received" in again.json()["error"]["message"]


@pytest.mark.parametrize(
    "forged",
    [
        {"signature_valid": False},  # not signed with this merchant's key
        {"signature_valid": None},  # not signed at all
        {"order_id": "DKNsomeoneelsesorder"},  # a success, but for another order
        {"mid": "ANOTHERMID0000000001"},  # a success, but for another Paytm merchant
    ],
)
def test_a_success_that_cannot_be_verified_is_not_believed(client_a, paytm, forged):
    product, cart = _bill(client_a)
    payment = _start(client_a, cart["id"])["payment"]
    paytm.says(TXN_SUCCESS, payment, **forged)

    res = _verify(client_a, payment["id"])
    assert res.status_code == 502 and res.json()["error"]["code"] == "paytm_failed"
    assert "could not be verified" in res.json()["error"]["message"]
    assert client_a.get(f"{START}/current", params={"cart_id": cart["id"]}).json()["status"] == "pending"
    assert _orders(client_a) == [] and _stock(client_a, product["id"]) == "10.000"


def test_the_browser_cannot_declare_a_payment_successful(client_a, paytm):
    product, cart = _bill(client_a)
    payment = _start(client_a, cart["id"])["payment"]  # Paytm has no transaction for it

    # Whatever the browser sends with the request, only Paytm's answer counts.
    claim = {"status": "paid", "STATUS": "TXN_SUCCESS", "TXNAMOUNT": "100.00", "txn_id": "FORGED"}
    res = client_a.post(f"{START}/{payment['id']}/verify", json=claim)
    assert res.status_code == 200 and (res.json()["status"], res.json()["txn_id"]) == ("pending", None)
    # Checkout does not accept Paytm as a method, and Paytm money cannot be recorded by naming the method.
    assert client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "paytm"}).status_code == 422
    customer = create_customer(client_a, name="Sunita")
    repay = client_a.post(f"/api/v1/customers/{customer['id']}/khata/payments", json={"amount": "10.00", "method": "paytm"})
    assert repay.status_code == 422
    assert _orders(client_a) == [] and _stock(client_a, product["id"]) == "10.000"


def test_a_network_failure_changes_nothing_and_checking_again_recovers(client_a, paytm):
    product, cart = _bill(client_a)
    payment = _start(client_a, cart["id"])["payment"]

    paytm.answer = PaytmError("Paytm did not answer in time")
    for action in (_verify, _cancel):
        res = action(client_a, payment["id"])
        assert res.status_code == 502 and "could not be checked" in res.json()["error"]["message"]
    assert client_a.get(f"{START}/current", params={"cart_id": cart["id"]}).json()["status"] == "pending"
    assert _orders(client_a) == []

    paytm.says(TXN_SUCCESS, payment)  # the payment had succeeded while the answer was lost
    assert _verify(client_a, payment["id"]).json()["status"] == "paid"
    assert len(_orders(client_a)) == 1 and _stock(client_a, product["id"]) == "8.000"


def test_paytm_being_unable_to_answer_is_not_a_failed_payment(client_a, paytm):
    product, cart = _bill(client_a)
    payment = _start(client_a, cart["id"])["payment"]

    # What Paytm's staging host really answers when it cannot look the order up: TXN_FAILURE with code 501.
    for code, msg in (("501", "System Error."), ("335", "Mid is invalid")):
        paytm.says(TXN_FAILURE, result_code=code, result_msg=msg)
        res = _verify(client_a, payment["id"])
        assert res.status_code == 502 and res.json()["error"]["details"] == {"paytm_code": code}
        assert msg in res.json()["error"]["message"] and "Nothing was changed" in res.json()["error"]["message"]
    assert client_a.get(f"{START}/current", params={"cart_id": cart["id"]}).json()["status"] == "pending"

    paytm.says(TXN_SUCCESS, payment)
    assert _verify(client_a, payment["id"]).json()["status"] == "paid"
    assert _stock(client_a, product["id"]) == "8.000"


# ---- money received, bill not completable ----


def test_a_bill_changed_after_paying_waits_for_the_merchant_and_completes_on_retry(client_a, paytm):
    product, cart = _bill(client_a)  # 2 × ₹50
    payment = _start(client_a, cart["id"])["payment"]
    item = cart["items"][0]
    client_a.patch(f"/api/v1/carts/{cart['id']}/items/{item['id']}", json={"quantity": "3"})  # edited in another tab
    paytm.says(TXN_SUCCESS, payment)

    res = _verify(client_a, payment["id"]).json()
    assert (res["status"], res["order_id"], res["txn_id"] is not None) == ("needs_review", None, True)
    assert "it is now ₹150.00, Paytm received ₹100.00" in res["detail"]
    assert _orders(client_a) == [] and _stock(client_a, product["id"]) == "10.000"

    client_a.patch(f"/api/v1/carts/{cart['id']}/items/{item['id']}", json={"quantity": "2"})  # put the bill back
    done = _verify(client_a, payment["id"]).json()
    assert (done["status"], done["detail"]) == ("paid", None)
    assert len(_orders(client_a)) == 1 and _stock(client_a, product["id"]) == "8.000"


def test_stock_that_ran_out_while_paying_is_not_oversold_and_not_deducted_twice(client_a, paytm, db):
    product, cart = _bill(client_a, quantity="2", stock="2")
    payment = _start(client_a, cart["id"])["payment"]
    # The last two were sold on another bill while the customer was paying.
    other = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{other['id']}/items", json={"product_id": product["id"], "quantity": "2"})
    assert client_a.post(f"/api/v1/carts/{other['id']}/checkout", json={"method": "cash"}).status_code == 201
    paytm.says(TXN_SUCCESS, payment)

    res = _verify(client_a, payment["id"]).json()
    assert res["status"] == "needs_review" and "in stock" in res["detail"]
    assert _stock(client_a, product["id"]) == "0.000" and len(_orders(client_a)) == 1
    assert db.scalar(select(func.count()).select_from(Payment)) == 1  # only the cash sale's money

    _adjust(client_a, product["id"], "5")
    done = _verify(client_a, payment["id"]).json()
    assert done["status"] == "paid"
    assert _stock(client_a, product["id"]) == "3.000"  # 5 restocked, 2 sold: deducted once
    assert len(_orders(client_a)) == 2


def test_paytm_money_for_a_bill_already_settled_another_way_does_not_make_a_second_sale(client_a, paytm):
    product, cart = _bill(client_a)
    payment = _start(client_a, cart["id"])["payment"]
    assert client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).status_code == 201
    paytm.says(TXN_SUCCESS, payment)

    res = _verify(client_a, payment["id"]).json()
    assert (res["status"], res["order_id"]) == ("needs_review", None)
    assert "Paytm received ₹100.00 but the bill was not completed: Cart is checked_out" == res["detail"]
    assert len(_orders(client_a)) == 1 and _stock(client_a, product["id"]) == "8.000"


# ---- merchant isolation ----


def test_a_merchant_cannot_see_verify_or_cancel_another_merchants_payment(client_a, client_b, paytm):
    product, cart = _bill(client_a)
    payment = _start(client_a, cart["id"])["payment"]
    paytm.says(TXN_SUCCESS, payment)

    for res in (
        _verify(client_b, payment["id"]),
        _cancel(client_b, payment["id"]),
        client_b.get(f"{START}/current", params={"cart_id": cart["id"]}),
    ):
        assert res.status_code == 404
    assert paytm.status_calls == 0  # Paytm was not even asked
    assert _orders(client_a) == [] and _orders(client_b) == [] and _stock(client_a, product["id"]) == "10.000"

    assert _verify(client_a, payment["id"]).json()["status"] == "paid"
    assert _orders(client_b) == []


# ---- the real client, against a stand-in for Paytm's HTTP API ----


def _server(handler):
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return HttpPaytmClient(CONFIG, transport=httpx.MockTransport(handle)), seen


def _signed(body: dict, head: dict | None = None, key: str = KEY) -> httpx.Response:
    """A response as Paytm sends it: the signature covers the body exactly as it appears on the wire."""
    body_json = json.dumps(body)
    head = {"responseTimestamp": "1553496322922", "version": "v1"} | (head or {"signature": generateSignature(body_json, key)})
    return httpx.Response(200, text=f'{{"head":{json.dumps(head)},"body":{body_json}}}')


def test_initiate_sends_the_documented_signed_request_and_returns_the_token():
    ok = {"resultInfo": {"resultStatus": "S", "resultCode": "0000", "resultMsg": "Success"}, "txnToken": "fe795335ed30"}
    client, seen = _server(lambda request: _signed(ok))

    token = client.initiate(order_id="DKNabc123", amount=Decimal("130"), customer_id="CUST_1")
    assert token == "fe795335ed30"
    [request] = seen
    assert request.method == "POST" and request.headers["content-type"] == "application/json"
    assert str(request.url) == (
        "https://securestage.paytmpayments.com/theia/api/v1/initiateTransaction?mid=TESTMID0000000000001&orderId=DKNabc123"
    )
    sent = json.loads(request.content)
    assert sent["body"] == {
        "requestType": "Payment",
        "mid": "TESTMID0000000000001",
        "websiteName": "WEBSTAGING",
        "orderId": "DKNabc123",
        "txnAmount": {"value": "130.00", "currency": "INR"},
        "userInfo": {"custId": "CUST_1"},
    }
    assert list(sent["head"]) == ["signature"]
    # The signature is Paytm's checksum over the body exactly as sent, and the key itself is not sent.
    raw_body = request.content.decode().split('"body":', 1)[1].rsplit(',"head":', 1)[0]
    assert verifySignature(raw_body, KEY, sent["head"]["signature"]) is True
    assert KEY not in request.content.decode() and KEY not in str(request.url)


def test_initiate_passes_a_configured_callback_url_and_reports_refusals():
    config = PaytmConfig(**(CONFIG.__dict__ | {"callback_url": "https://shop.example/paytm/callback"}))
    seen = []

    def handle(request):
        seen.append(json.loads(request.content)["body"])
        return _signed({"resultInfo": {"resultStatus": "S", "resultCode": "0002", "resultMsg": "Success Idempotent"}, "txnToken": "t1"})

    assert HttpPaytmClient(config, transport=httpx.MockTransport(handle)).initiate(
        order_id="DKN1", amount=Decimal("1.5"), customer_id="C"
    ) == "t1"
    assert seen[0]["callbackUrl"] == "https://shop.example/paytm/callback" and seen[0]["txnAmount"]["value"] == "1.50"

    refused = {"resultInfo": {"resultStatus": "F", "resultCode": "2005", "resultMsg": "Checksum provided is invalid"}}
    client, _ = _server(lambda request: _signed(refused))
    with pytest.raises(PaytmRejected, match="Checksum provided is invalid") as error:
        client.initiate(order_id="DKN1", amount=Decimal("1"), customer_id="C")
    assert error.value.code == "2005"
    no_token = {"resultInfo": {"resultStatus": "S", "resultCode": "0000", "resultMsg": "Success"}}
    client, _ = _server(lambda request: _signed(no_token))
    with pytest.raises(PaytmRejected):
        client.initiate(order_id="DKN1", amount=Decimal("1"), customer_id="C")


STATUS_BODY = {
    "resultInfo": {"resultStatus": "TXN_SUCCESS", "resultCode": "01", "resultMsg": "Txn Success"},
    "txnId": "20261003111212800110168470101509706",
    "bankTxnId": "777001234215242",
    "orderId": "DKNabc123",
    "txnAmount": "130.00",
    "txnType": "SALE",
    "gatewayName": "HDFC",
    "bankName": "HSBC",
    "mid": "TESTMID0000000000001",
    "paymentMode": "UPI",
    "txnDate": "2026-10-03 12:35:20.0",
}


def test_status_reads_paytms_answer_and_checks_its_signature():
    client, seen = _server(lambda request: _signed(STATUS_BODY))
    txn = client.status("DKNabc123")
    assert txn == PaytmTransaction(
        result_status=TXN_SUCCESS, result_code="01", result_msg="Txn Success", order_id="DKNabc123",
        mid="TESTMID0000000000001", txn_id="20261003111212800110168470101509706", bank_txn_id="777001234215242",
        amount=Decimal("130.00"), payment_mode="UPI", signature_valid=True,
    )  # fmt: skip
    [request] = seen
    assert str(request.url) == "https://securestage.paytmpayments.com/v3/order/status"
    sent = json.loads(request.content)
    assert sent["body"] == {"mid": "TESTMID0000000000001", "orderId": "DKNabc123"}
    assert verifySignature('{"mid":"TESTMID0000000000001","orderId":"DKNabc123"}', KEY, sent["head"]["signature"]) is True

    # Signed with another key, tampered after signing, or not signed: never "valid".
    client, _ = _server(lambda request: _signed(STATUS_BODY, key="fedcba9876543210"))
    assert client.status("DKNabc123").signature_valid is False
    client, _ = _server(lambda request: _signed(STATUS_BODY, head={"signature": "not-a-checksum"}))
    assert client.status("DKNabc123").signature_valid is False
    tampered = _signed(STATUS_BODY).text.replace('"130.00"', '"1.00"')
    client, _ = _server(lambda request: httpx.Response(200, text=tampered))
    answer = client.status("DKNabc123")
    assert (answer.amount, answer.signature_valid) == (Decimal("1.00"), False)
    client, _ = _server(lambda request: _signed(STATUS_BODY, head={"version": "v1"}))
    assert client.status("DKNabc123").signature_valid is None

    pending = {"resultInfo": {"resultStatus": "PENDING", "resultCode": "402", "resultMsg": "Looks like the payment is not complete."}}
    client, _ = _server(lambda request: _signed(pending | {"txnAmount": "not-a-number"}))
    txn = client.status("DKNabc123")
    assert (txn.result_status, txn.result_code, txn.amount, txn.txn_id) == (PENDING, "402", None, None)


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(500, text="Internal Server Error"),
        httpx.Response(200, text="<html>maintenance</html>"),
        httpx.Response(200, text='{"head":{}}'),
        httpx.Response(200, text='{"head":{},"body":{"resultInfo":{}}}'),
        httpx.ReadTimeout("timed out"),
        httpx.ConnectError("no route"),
    ],
)
def test_an_unusable_answer_is_an_error_never_a_payment_state(answer):
    def handle(request):
        if isinstance(answer, Exception):
            raise answer
        return answer

    client, _ = _server(handle)
    with pytest.raises(PaytmError) as error:
        client.status("DKNabc123")
    assert not isinstance(error.value, PaytmRejected) and KEY not in str(error.value)
    with pytest.raises(PaytmError):
        client.initiate(order_id="DKNabc123", amount=Decimal("1"), customer_id="C")
