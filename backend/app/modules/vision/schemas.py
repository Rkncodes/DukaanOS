from enum import StrEnum

from pydantic import BaseModel, Field

from app.core.types import QuantityOut
from app.modules.catalog.schemas import ProductRead


class MatchState(StrEnum):
    MATCHED = "matched"  # exactly one catalog product and a confident detection
    LOW_CONFIDENCE = "low_confidence"  # one catalog product, but the detection itself is uncertain
    AMBIGUOUS = "ambiguous"  # several catalog products fit: the merchant must pick
    UNMATCHED = "unmatched"  # nothing in this merchant's catalog fits


class BoundingBoxRead(BaseModel):
    """Normalized to the image size (0..1, origin top-left)."""

    x: float
    y: float
    width: float
    height: float


class Detection(BaseModel):
    """One thing the provider saw, and how it maps onto this merchant's catalog.
    Nothing is added to a cart until the merchant confirms."""

    id: str  # stable within one result, for the UI
    label: str | None  # what the provider called it
    barcode: str | None
    quantity: QuantityOut
    confidence: float | None = Field(ge=0, le=1)
    bbox: BoundingBoxRead | None
    match: MatchState
    product: ProductRead | None  # set only when match == matched
    candidates: list[ProductRead]  # choices for low_confidence / ambiguous, best first


class VisionResult(BaseModel):
    provider: str
    is_mock: bool  # true: fixed demo output, not real recognition
    detections: list[Detection]
    sequence: int | None = None  # live frames only: echoes the client's frame counter
