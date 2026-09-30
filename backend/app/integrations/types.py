import uuid
from dataclasses import dataclass
from decimal import Decimal

from app.core.enums import InputSource


class IntegrationNotConfigured(RuntimeError):
    """Raised by placeholder providers until a real provider is plugged in."""


@dataclass(frozen=True)
class RecognizedItem:
    """A billing line proposed by any input channel, before product resolution.

    At least one of product_id / barcode / name_hint should be set; resolution
    happens in billing.service (tenant-scoped), never in the integration.
    """

    source: InputSource
    quantity: Decimal = Decimal(1)
    product_id: uuid.UUID | None = None
    barcode: str | None = None
    name_hint: str | None = None
    confidence: float | None = None
