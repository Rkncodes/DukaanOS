"""Payment provider abstraction.

The methods here settle immediately (cash, or UPI/card the merchant confirms on their own
device). Paytm is not one of them: its money is only recorded after the backend has verified
it with Paytm (app.modules.payments.paytm), so it can never be "collected" by naming the method.
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

from app.core.enums import PaymentMethod, PaymentRecordStatus
from app.core.errors import DomainValidationError


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
    provider = _PROVIDERS.get(method)
    if provider is None:
        raise DomainValidationError("Paytm payments are taken with 'Pay with Paytm', which verifies them with Paytm")
    return provider
