import uuid
from dataclasses import dataclass
from decimal import Decimal

from app.core.enums import InputSource


class IntegrationNotConfigured(RuntimeError):
    """Raised by placeholder providers until a real provider is plugged in."""


@dataclass(frozen=True)
class BoundingBox:
    """Where an item was seen, normalized to the image size (0..1, origin top-left)."""

    x: float
    y: float
    width: float
    height: float


def overlap(a: BoundingBox, b: BoundingBox) -> tuple[float, float]:
    """(intersection over union, intersection over the smaller box)."""
    ix = max(0.0, min(a.x + a.width, b.x + b.width) - max(a.x, b.x))
    iy = max(0.0, min(a.y + a.height, b.y + b.height) - max(a.y, b.y))
    inter = ix * iy
    area_a, area_b = a.width * a.height, b.width * b.height
    union = area_a + area_b - inter
    smaller = min(area_a, area_b)
    return (inter / union if union > 0 else 0.0), (inter / smaller if smaller > 0 else 0.0)


@dataclass(frozen=True)
class Evidence:
    """What a vision provider observed for one detected object, *before* any catalog decision.

    The provider never decides the product: app.modules.vision fuses this with the merchant's
    catalog (names, reference images) and decides matched / ambiguous / unsure / unknown.
    """

    visual: tuple[tuple[str, float], ...] = ()  # (catalog label, relative visual score), best first
    visual_other: float = 0.0  # visual score of "none of these products"
    text: str = ""  # printed text read inside the box (OCR); may be noisy or empty
    embedding: tuple[float, ...] = ()  # appearance embedding of the crop (for reference images)
    embedding_model: str | None = None  # which model produced `embedding` (references must match)
    locate_score: float = 0.0  # how strongly the detector thinks this is a product


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
    label: str | None = None  # what the provider calls it, for display; defaults to name_hint
    confidence: float | None = None  # 0..1, as reported by the provider
    bbox: BoundingBox | None = None
    evidence: Evidence | None = None  # raw observations for catalog-grounded matching (real vision)
