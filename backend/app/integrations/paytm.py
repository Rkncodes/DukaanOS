"""Paytm Payment Gateway: the two server-to-server calls of Paytm's JS Checkout flow.

    1. Initiate Transaction API  -> txnToken, which the browser hands to Paytm's JS Checkout
    2. Transaction Status API    -> what Paytm itself says happened to an order

Written against Paytm's developer documentation (paytmpayments.com/docs):
    jscheckout-initiate-payment, jscheckout-invoke-payment, jscheckout-verify-payment,
    api/initiate-transaction-api, api/v3/transaction-status-api, checksum-implementation,
    jscheckout-test-go-live (hosts and WEBSTAGING / DEFAULT).

Requests are signed with Paytm's own checksum library over the exact body that is sent. The
merchant key never leaves this module. Whether a bill is paid is decided in
app.modules.payments.paytm from PaytmTransaction, never here and never by the browser.
"""

import json
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

import httpx
from paytmchecksum import generateSignature, verifySignature

# jscheckout-test-go-live: "Host Details are different for Staging and Production."
HOSTS = {"sandbox": "https://securestage.paytmpayments.com", "production": "https://secure.paytmpayments.com"}
# initiate-transaction-api, websiteName: "WEBSTAGING (for staging/testing environment), DEFAULT (for production environment)"
WEBSITES = {"sandbox": "WEBSTAGING", "production": "DEFAULT"}

# Transaction Status API, body.resultInfo.resultStatus
TXN_SUCCESS = "TXN_SUCCESS"
TXN_FAILURE = "TXN_FAILURE"
PENDING = "PENDING"
NO_RECORD_FOUND = "NO_RECORD_FOUND"


@dataclass(frozen=True)
class PaytmConfig:
    environment: str  # "sandbox" | "production"
    host: str
    mid: str
    merchant_key: str = field(repr=False)
    website: str
    callback_url: str | None = None
    timeout_seconds: float = 15
    verify_response_signature: bool = True


@dataclass(frozen=True)
class PaytmTransaction:
    """Paytm's answer about one order (Transaction Status API response body)."""

    result_status: str  # TXN_SUCCESS | TXN_FAILURE | PENDING | NO_RECORD_FOUND
    result_code: str | None = None
    result_msg: str | None = None
    order_id: str | None = None
    mid: str | None = None
    txn_id: str | None = None
    bank_txn_id: str | None = None
    amount: Decimal | None = None
    payment_mode: str | None = None
    signature_valid: bool | None = None  # None: the response carried no signature, or checking is switched off


class PaytmError(Exception):
    """Paytm could not be reached, or answered something that cannot be used. Nothing is known
    about the payment: the caller must not change its state."""


class PaytmRejected(PaytmError):
    """Paytm answered and refused the request (Initiate Transaction resultStatus F / U)."""

    def __init__(self, code: str | None, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class PaytmClient(Protocol):
    def initiate(self, *, order_id: str, amount: Decimal, customer_id: str) -> str:
        """Create (or repeat) the Paytm order and return its txnToken."""
        ...

    def status(self, order_id: str) -> PaytmTransaction: ...


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _raw_body(text: str, body: Any) -> str | None:
    """The response's "body" exactly as Paytm sent it: the string its signature was made over."""
    decoder = json.JSONDecoder()
    for found in re.finditer(r'"body"\s*:\s*', text):
        try:
            value, end = decoder.raw_decode(text, found.end())
        except ValueError:
            continue
        if value == body:
            return text[found.end() : end]
    return None


class HttpPaytmClient:
    name = "paytm"

    def __init__(self, config: PaytmConfig, transport: httpx.BaseTransport | None = None):
        self.config = config
        self._transport = transport

    def _post(self, path: str, body: dict[str, Any], params: dict[str, str] | None = None) -> tuple[str, dict[str, Any]]:
        """Signed POST. Returns (raw response text, parsed response)."""
        # "Create the signature using the body parameter of the request": sign the very string that is sent.
        body_json = json.dumps(body, separators=(",", ":"))
        head_json = json.dumps({"signature": generateSignature(body_json, self.config.merchant_key)})
        content = f'{{"body":{body_json},"head":{head_json}}}'
        try:
            with httpx.Client(timeout=self.config.timeout_seconds, transport=self._transport) as http:
                response = http.post(
                    self.config.host + path, params=params, content=content, headers={"Content-Type": "application/json"}
                )
        except httpx.TimeoutException as exc:
            raise PaytmError("Paytm did not answer in time") from exc
        except httpx.HTTPError as exc:
            raise PaytmError("Paytm could not be reached") from exc
        if response.status_code != 200:
            raise PaytmError(f"Paytm answered HTTP {response.status_code}")
        try:
            data = response.json()
        except ValueError as exc:
            raise PaytmError("Paytm sent an unreadable answer") from exc
        if not isinstance(data, dict) or not isinstance(data.get("body"), dict):
            raise PaytmError("Paytm sent an unreadable answer")
        return response.text, data

    def initiate(self, *, order_id: str, amount: Decimal, customer_id: str) -> str:
        body: dict[str, Any] = {
            "requestType": "Payment",
            "mid": self.config.mid,
            "websiteName": self.config.website,
            "orderId": order_id,
            "txnAmount": {"value": str(amount.quantize(Decimal("0.01"))), "currency": "INR"},
            "userInfo": {"custId": customer_id},
        }
        if self.config.callback_url:
            body["callbackUrl"] = self.config.callback_url
        _, data = self._post(
            "/theia/api/v1/initiateTransaction", body, params={"mid": self.config.mid, "orderId": order_id}
        )
        result = data["body"].get("resultInfo")
        result = result if isinstance(result, dict) else {}
        token = _text(data["body"].get("txnToken"))
        # resultStatus S: 0000 Success, 0002 Success Idempotent (the same order asked for again).
        if result.get("resultStatus") != "S" or token is None:
            raise PaytmRejected(_text(result.get("resultCode")), _text(result.get("resultMsg")) or "Paytm refused the payment request")
        return token

    def status(self, order_id: str) -> PaytmTransaction:
        text, data = self._post("/v3/order/status", {"mid": self.config.mid, "orderId": order_id})
        body = data["body"]
        result = body.get("resultInfo")
        result = result if isinstance(result, dict) else {}
        status = _text(result.get("resultStatus"))
        if status is None:
            raise PaytmError("Paytm sent an unreadable answer")
        try:
            amount = Decimal(body["txnAmount"]) if _text(body.get("txnAmount")) else None
        except InvalidOperation:
            amount = None
        return PaytmTransaction(
            result_status=status,
            result_code=_text(result.get("resultCode")),
            result_msg=_text(result.get("resultMsg")),
            order_id=_text(body.get("orderId")),
            mid=_text(body.get("mid")),
            txn_id=_text(body.get("txnId")),
            bank_txn_id=_text(body.get("bankTxnId")),
            amount=amount if amount is not None and amount.is_finite() else None,
            payment_mode=_text(body.get("paymentMode")),
            signature_valid=self._signature_valid(text, data),
        )

    def _signature_valid(self, text: str, data: dict[str, Any]) -> bool | None:
        if not self.config.verify_response_signature:
            return None
        head = data.get("head")
        signature = _text(head.get("signature")) if isinstance(head, dict) else None
        if signature is None:
            return None
        raw = _raw_body(text, data["body"])
        if raw is None:
            return False
        try:
            return bool(verifySignature(raw, self.config.merchant_key, signature))
        except Exception:  # not made with this merchant key: undecryptable
            return False

