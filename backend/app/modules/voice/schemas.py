from pydantic import BaseModel, Field

from app.core.types import QuantityOut
from app.modules.catalog.schemas import ProductRead
from app.modules.vision.schemas import MatchState  # the same four outcomes as every recognized input

MAX_TRANSCRIPT_CHARS = 1000


class VoiceRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=MAX_TRANSCRIPT_CHARS)  # what speech-to-text heard


class VoiceLine(BaseModel):
    """One spoken item and how it maps onto this merchant's catalogue.
    Nothing is added to a cart until the merchant confirms."""

    id: str  # stable within one result, for the UI
    raw_text: str  # the item as heard, number words as digits ("2 Maggi")
    description: str  # the product words of the item (the quantity removed)
    quantity: QuantityOut | None  # null: no reliable quantity was said; the merchant must enter it
    match: MatchState
    product: ProductRead | None  # set only when match == matched
    candidates: list[ProductRead]  # choices for low_confidence / ambiguous, best first
    match_confidence: float | None = Field(ge=0, le=1)  # share of the spoken words found in the product's name
    matched_words: list[str]  # why: the spoken words found in the product's name...
    unmatched_words: list[str]  # ...and the ones that were not


class VoiceResult(BaseModel):
    transcript: str
    lines: list[VoiceLine]
