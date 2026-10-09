"""Paying an open Counter bill through Paytm.

    start()   bill total computed here -> Paytm order (Initiate Transaction API) -> txnToken for the browser
    verify()  ask Paytm what happened (Transaction Status API) -> only TXN_SUCCESS completes the bill
    cancel()  give the attempt up, unless Paytm has (or may still get) the money

The cart stays open and no stock moves until Paytm confirms the money. Then the bill is completed
exactly once by the existing orders.checkout, with the verified payment attached. Nothing the
browser says about a payment is used: every state change comes from Paytm's own answer.
"""

import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.db import utcnow
from app.core.enums import CheckoutMethod, PaymentMethod, PaymentRecordStatus, PaytmPaymentStatus
from app.core.errors import Conflict, DomainError, DomainValidationError, InsufficientStock
from app.core.tenancy import TenantContext, get_owned, scoped
from app.integrations.paytm import (
    NO_RECORD_FOUND,
    PENDING,
    TXN_FAILURE,
    TXN_SUCCESS,
    PaytmClient,
    PaytmConfig,
    PaytmError,
    PaytmRejected,
    PaytmTransaction,
)
from app.modules.billing import service as billing
from app.modules.billing.models import Cart
from app.modules.billing.schemas import CheckoutRequest
from app.modules.orders import service as orders
from app.modules.payments.models import Payment, PaytmPayment

PROVIDER = "paytm"
LIVE = (PaytmPaymentStatus.PENDING, PaytmPaymentStatus.NEEDS_REVIEW)
# Transaction Status API: 331 "No Record Found", 334 "Invalid Order ID". Paytm has no transaction
# for the order: the customer has not paid (yet). Unlike the other TXN_FAILURE codes, nothing failed.
NO_TRANSACTION_CODES = {"331", "334"}
# 501 "Server Down" / "System Error", 335 "Mid is invalid": Paytm could not answer about the order.
# They arrive as TXN_FAILURE but say nothing about the payment, so they must not fail it.
NO_ANSWER_CODES = {"501", "335"}


class PaytmUnavailable(DomainError):
    status_code = 503
    code = "paytm_unavailable"


class PaytmFailed(DomainError):
    """Paytm could not be reached, refused, or its answer could not be trusted. Nothing changed."""

    status_code = 502
    code = "paytm_failed"


@dataclass(frozen=True)
class Paytm:
    """The configured gateway: what was set in the environment and the client that talks to it."""

    config: PaytmConfig
    client: PaytmClient


def _money(amount: Decimal) -> str:
    return f"₹{amount.quantize(Decimal('0.01'))}"


def current_for_cart(db: Session, ctx: TenantContext, cart_id: uuid.UUID) -> PaytmPayment | None:
    """The attempt that is in flight, or holding received money, for this bill."""
    stmt = scoped(PaytmPayment, ctx).where(PaytmPayment.cart_id == cart_id, PaytmPayment.status.in_(LIVE))
    return db.scalars(stmt).one_or_none()


def _check_stock(cart: Cart) -> None:
    """Fail before Paytm is involved, with the same error checkout would give after the money came in."""
    for item in cart.items:
        if item.product.stock_quantity < item.quantity:
            raise InsufficientStock(
                f"Only {item.product.stock_quantity.normalize()} {item.product.unit} of {item.product.name} in stock",
                details={
                    "product_id": str(item.product_id),
                    "requested": str(item.quantity),
                    "available": str(item.product.stock_quantity),
                },
            )


def start(
    db: Session, ctx: TenantContext, paytm: Paytm, cart_id: uuid.UUID, discount: Decimal
) -> tuple[PaytmPayment, str]:
    """Begin (or continue) collecting this bill. The amount is the bill's total as computed here;
    the browser supplies none. Returns the attempt and the txnToken for Paytm's JS Checkout."""
    cart = billing.get_open_cart(db, ctx, cart_id)  # this merchant's, still open, row locked
    if not cart.items:
        raise DomainValidationError("Cart is empty")
    if discount > cart.subtotal:
        raise DomainValidationError("Discount cannot exceed subtotal")
    total = cart.subtotal - discount
    if total <= 0:
        raise DomainValidationError("There is nothing to collect on this bill")
    _check_stock(cart)

    payment = current_for_cart(db, ctx, cart.id)
    if payment is not None and payment.status == PaytmPaymentStatus.NEEDS_REVIEW:
        raise Conflict(
            f"Paytm already received {_money(payment.amount)} for this bill. Check its status to complete the bill.",
            details={"payment_id": str(payment.id)},
        )
    if payment is not None and (payment.amount != total or payment.discount != discount):
        raise Conflict(
            f"A Paytm payment of {_money(payment.amount)} is already in progress for this bill. "
            "Check its status or cancel it before starting another.",
            details={"payment_id": str(payment.id)},
        )
    if payment is None:
        payment_id = uuid.uuid4()
        payment = PaytmPayment(
            id=payment_id,
            merchant_id=ctx.merchant_id,
            cart_id=cart.id,
            paytm_order_id=f"DKN{payment_id.hex}",
            environment=paytm.config.environment,
            amount=total,
            discount=discount,
            status=PaytmPaymentStatus.PENDING,
        )
        db.add(payment)
        db.flush()

    customer = f"CUST_{cart.customer_id.hex}" if cart.customer_id else f"COUNTER_{ctx.merchant_id.hex}"
    try:
        # Asking again for the same order and amount is answered by Paytm with the same order
        # ("Success Idempotent"), so a double click or a refresh continues this attempt.
        token = paytm.client.initiate(order_id=payment.paytm_order_id, amount=payment.amount, customer_id=customer)
    except PaytmRejected as exc:
        raise PaytmFailed(f"Paytm refused the payment request: {exc.message}", details={"paytm_code": exc.code}) from exc
    except PaytmError as exc:
        raise PaytmFailed(f"The Paytm payment could not be started: {exc}. Nothing was charged.") from exc
    return payment, token


def _locked(db: Session, ctx: TenantContext, payment_id: uuid.UUID) -> PaytmPayment:
    return get_owned(db, PaytmPayment, payment_id, ctx, label="Paytm payment", for_update=True)


def _ask_paytm(paytm: Paytm, payment: PaytmPayment) -> PaytmTransaction:
    try:
        txn = paytm.client.status(payment.paytm_order_id)
    except PaytmError as exc:
        raise PaytmFailed(f"The payment status could not be checked: {exc}. Nothing was changed; check again.") from exc
    if txn.result_status not in (TXN_SUCCESS, TXN_FAILURE, PENDING, NO_RECORD_FOUND):
        raise PaytmFailed("Paytm sent a status that is not understood. Nothing was changed; check again.")
    if txn.result_status == TXN_FAILURE and txn.result_code in NO_ANSWER_CODES:
        raise PaytmFailed(
            f"Paytm could not report on this payment ({txn.result_code}: {txn.result_msg or 'no reason given'}). "
            "Nothing was changed; check again.",
            details={"paytm_code": txn.result_code},
        )
    if txn.result_status == TXN_SUCCESS:
        # A success is only believed when it is provably Paytm's answer about this very order.
        unsigned = paytm.config.verify_response_signature and txn.signature_valid is not True
        if unsigned or txn.order_id != payment.paytm_order_id or txn.mid != paytm.config.mid:
            raise PaytmFailed("Paytm's answer could not be verified. The bill was not marked paid; check again.")
    return txn


def _complete(db: Session, ctx: TenantContext, payment: PaytmPayment) -> None:
    """Money is verified: complete the bill through the one existing checkout, exactly once.
    If the bill cannot be completed the money is still on record (needs_review) and this can be retried."""
    payment.status = PaytmPaymentStatus.NEEDS_REVIEW
    try:
        with db.begin_nested():  # a failed checkout leaves no half-made order and no stock change
            cart = billing.get_open_cart(db, ctx, payment.cart_id)
            total = cart.subtotal - payment.discount
            if total != payment.amount:
                raise Conflict(
                    f"The bill changed after the payment started: it is now {_money(total)}, "
                    f"Paytm received {_money(payment.amount)}"
                )
            received = Payment(
                merchant_id=ctx.merchant_id,
                customer_id=cart.customer_id,
                amount=payment.amount,
                method=PaymentMethod.PAYTM,
                status=PaymentRecordStatus.SUCCEEDED,
                provider=PROVIDER,
                external_reference=payment.txn_id,
            )
            # `received` settles the bill; the method named here is not used.
            request = CheckoutRequest(method=CheckoutMethod.UPI, discount=payment.discount)
            order = orders.checkout(db, ctx, cart.id, request, received=received)
    except DomainError as exc:
        payment.detail = f"Paytm received {_money(payment.amount)} but the bill was not completed: {exc.message}"[:255]
        db.flush()
        return
    payment.status = PaytmPaymentStatus.PAID
    payment.order_id = order.id
    payment.payment_id = received.id
    payment.detail = None
    db.flush()


def _apply(
    db: Session, ctx: TenantContext, payment: PaytmPayment, txn: PaytmTransaction, *, cancelling: bool = False
) -> None:
    payment.result_code, payment.result_msg = txn.result_code, (txn.result_msg or "")[:255] or None
    if txn.result_status == TXN_SUCCESS:
        payment.txn_id, payment.bank_txn_id, payment.payment_mode = txn.txn_id, txn.bank_txn_id, txn.payment_mode
        payment.verified_at = payment.verified_at or utcnow()
        if txn.amount != payment.amount:
            payment.status = PaytmPaymentStatus.NEEDS_REVIEW
            received = "an unknown amount" if txn.amount is None else _money(txn.amount)
            payment.detail = f"Paytm received {received} but the bill is {_money(payment.amount)}. The bill was not completed."
            db.flush()
            return
        _complete(db, ctx, payment)
        return
    if payment.verified_at is not None:  # money already confirmed earlier is never downgraded
        db.flush()
        return
    no_transaction = txn.result_status == NO_RECORD_FOUND or txn.result_code in NO_TRANSACTION_CODES
    if txn.result_status == PENDING:
        if cancelling:
            raise Conflict(
                "Paytm is still confirming a payment for this bill with the bank, so it cannot be cancelled yet. "
                "Check the status again in a moment."
            )
    elif no_transaction:
        if cancelling:
            payment.status = PaytmPaymentStatus.CANCELLED
    else:  # TXN_FAILURE
        payment.status = PaytmPaymentStatus.FAILED
    db.flush()


def verify(db: Session, ctx: TenantContext, paytm: Paytm, payment_id: uuid.UUID) -> PaytmPayment:
    """Fetch the truth from Paytm and act on it. Safe to call any number of times."""
    payment = _locked(db, ctx, payment_id)  # concurrent checks of one payment run one after another
    if payment.status == PaytmPaymentStatus.PAID:
        return payment
    _apply(db, ctx, payment, _ask_paytm(paytm, payment))
    return payment


def cancel(db: Session, ctx: TenantContext, paytm: Paytm, payment_id: uuid.UUID) -> PaytmPayment:
    """Give the attempt up. Paytm is asked first: money that has arrived is never cancelled away."""
    payment = _locked(db, ctx, payment_id)
    if payment.status != PaytmPaymentStatus.PENDING:
        return payment
    _apply(db, ctx, payment, _ask_paytm(paytm, payment), cancelling=True)
    return payment
