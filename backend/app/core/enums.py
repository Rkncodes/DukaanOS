"""Shared domain enums. Stored as VARCHAR + CHECK constraint (see enum_check)."""

from enum import StrEnum

from sqlalchemy import CheckConstraint


class UserRole(StrEnum):
    OWNER = "owner"
    STAFF = "staff"


class InputSource(StrEnum):
    """How a line item / ledger entry entered the system. Every billing input
    (manual, barcode, vision, voice, parchi, assistant) converges on the same services."""

    MANUAL = "manual"
    BARCODE = "barcode"
    VISION = "vision"
    VOICE = "voice"
    PARCHI = "parchi"
    ASSISTANT = "assistant"


class Channel(StrEnum):
    COUNTER = "counter"
    SHOP = "shop"


class CartStatus(StrEnum):
    OPEN = "open"
    CHECKED_OUT = "checked_out"
    ABANDONED = "abandoned"


class OrderStatus(StrEnum):
    """A Counter bill is completed at checkout. A Shop order is placed pending and the merchant
    moves it: pending -> confirmed -> ready -> completed, or cancels it before completion
    (orders.service.TRANSITIONS)."""

    PENDING = "pending"
    CONFIRMED = "confirmed"
    READY = "ready"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class PaymentStatus(StrEnum):
    UNPAID = "unpaid"
    PAID = "paid"
    CREDIT = "credit"  # settled on khata (udhaar)


class PaymentMethod(StrEnum):
    CASH = "cash"
    UPI = "upi"
    CARD = "card"
    PAYTM = "paytm"  # collected and verified through the Paytm gateway (payments.paytm), never by checkout


class CheckoutMethod(StrEnum):
    """PaymentMethod plus KHATA (no money changes hands; a khata credit is recorded)."""

    CASH = "cash"
    UPI = "upi"
    CARD = "card"
    KHATA = "khata"


class PaymentRecordStatus(StrEnum):
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    REFUNDED = "refunded"


class PaytmPaymentStatus(StrEnum):
    """One Paytm attempt for a bill. Only Paytm's own answer, fetched by the backend, moves it."""

    PENDING = "pending"  # started; Paytm has not reported a final result
    PAID = "paid"  # Paytm confirmed the money and the bill was completed
    FAILED = "failed"  # Paytm reported the transaction as failed
    CANCELLED = "cancelled"  # given up before Paytm received any money
    NEEDS_REVIEW = "needs_review"  # Paytm received money but the bill could not be completed


class KhataEntryType(StrEnum):
    CREDIT = "credit"  # udhaar given: customer owes more
    PAYMENT = "payment"  # customer paid back


class InsightActionStatus(StrEnum):
    """What a staff member did about a computed insight (app.modules.insights). The insight
    itself is never stored, only this, keyed by its stable insight_key."""

    SNOOZED = "snoozed"
    DISMISSED = "dismissed"
    RESOLVED = "resolved"


def enum_check(column: str, enum: type[StrEnum]) -> CheckConstraint:
    values = ", ".join(f"'{m.value}'" for m in enum)
    return CheckConstraint(f"{column} IN ({values})", name=f"{column}_valid")
