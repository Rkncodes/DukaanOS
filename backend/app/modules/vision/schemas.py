import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field

from app.core.types import QuantityOut, Schema
from app.modules.catalog.schemas import ProductRead


class MatchState(StrEnum):
    MATCHED = "matched"  # exactly one catalog product, with enough evidence and a clear lead
    LOW_CONFIDENCE = "low_confidence"  # one catalog product leads, but the evidence is not strong: confirm
    AMBIGUOUS = "ambiguous"  # several catalog products fit about equally: the merchant must pick
    UNMATCHED = "unmatched"  # nothing in this merchant's catalog is supported by what was seen


class BoundingBoxRead(BaseModel):
    """Normalized to the image size (0..1, origin top-left)."""

    x: float
    y: float
    width: float
    height: float


class DetectionEvidence(BaseModel):
    """Why the top catalog product was (or was not) chosen: 0..1 support from each signal.
    These are evidence scores, not calibrated probabilities."""

    visual: float  # how much the crop looks like the product's name suggests
    text: float  # how much of the product's name was read on the pack
    reference: float  # similarity to the merchant's reference photos of the product
    read_text: str  # the printed text read inside the box


class Detection(BaseModel):
    """One thing the provider saw, and how it maps onto this merchant's catalog.
    Nothing is added to a cart until the merchant confirms."""

    id: str  # stable within one result, for the UI
    label: str | None  # what the provider called it
    barcode: str | None
    quantity: QuantityOut
    confidence: float | None = Field(ge=0, le=1)  # evidence for the top product (a score, not a probability)
    bbox: BoundingBoxRead | None
    match: MatchState
    product: ProductRead | None  # set only when match == matched
    candidates: list[ProductRead]  # choices for low_confidence / ambiguous, best first
    evidence: DetectionEvidence | None = None  # real vision only


class VisionResult(BaseModel):
    provider: str
    is_mock: bool  # true only for a test/demo provider; the app ships none (always false at runtime)
    detections: list[Detection]
    sequence: int | None = None  # live frames only: echoes the client's frame counter


class ReferenceImageRead(Schema):
    """A merchant's photo of a product's real packaging (only a thumbnail is kept)."""

    id: uuid.UUID
    product_id: uuid.UUID
    created_at: datetime
