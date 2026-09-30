"""Payment provider abstraction.

Today every method settles immediately (cash, or UPI/card the merchant confirms on
their own device). A gateway such as Paytm plugs in by implementing PaymentProvider,
returning PENDING, and confirming later via a webhook -> payments.service.
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

from app.core.enums import PaymentMethod, PaymentRecordStatus


@dataclass(frozen=True)
class ProviderResult:
    status: PaymentRecordStatus
    external_reference: str | None = None


class PaymentProvider(Protocol):
    name: str

    def collect(self, *, amount: Decimal, method: PaymentMethod, reference: str) -> ProviderResult: ...


class CashProvider:
    name = "cash"

    def collect(self, *, amount: Decimal, method: PaymentMethod, reference: str) -> ProviderResult:
        return ProviderResult(status=PaymentRecordStatus.SUCCEEDED)


class ManualConfirmationProvider:
    """Merchant confirms receipt out-of-band (e.g. customer scanned the shop's static UPI QR)."""

    name = "manual"

    def collect(self, *, amount: Decimal, method: PaymentMethod, reference: str) -> ProviderResult:
        return ProviderResult(status=PaymentRecordStatus.SUCCEEDED)


_PROVIDERS: dict[PaymentMethod, PaymentProvider] = {
    PaymentMethod.CASH: CashProvider(),
    PaymentMethod.UPI: ManualConfirmationProvider(),
    PaymentMethod.CARD: ManualConfirmationProvider(),
}


def get_provider(method: PaymentMethod) -> PaymentProvider:
    return _PROVIDERS[method]
