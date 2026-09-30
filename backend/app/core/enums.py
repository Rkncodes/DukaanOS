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
    PENDING = "pending"
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


class KhataEntryType(StrEnum):
    CREDIT = "credit"  # udhaar given: customer owes more
    PAYMENT = "payment"  # customer paid back


def enum_check(column: str, enum: type[StrEnum]) -> CheckConstraint:
    values = ", ".join(f"'{m.value}'" for m in enum)
    return CheckConstraint(f"{column} IN ({values})", name=f"{column}_valid")
