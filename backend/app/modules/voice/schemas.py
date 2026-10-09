import uuid
from typing import Literal

from pydantic import BaseModel, Field

from app.core.types import QuantityOut
from app.modules.catalog.schemas import ProductRead
from app.modules.vision.schemas import MatchState  # the same four outcomes as every recognized input

MAX_TRANSCRIPT_CHARS = 1000

# What was asked of the bill. "add" is the default: anything that is not clearly another command.
VoiceIntent = Literal["add", "remove", "set_quantity", "total", "clear"]


class VoiceRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=MAX_TRANSCRIPT_CHARS)  # what speech-to-text heard
    # The open bill, if there is one. "Remove ..." and "change ... quantity" are about what is on it.
    cart_id: uuid.UUID | None = None


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
    intent: VoiceIntent = "add"
    # add: the items to add. remove / set_quantity: the items of the open bill that were meant
    # (matched against that bill only). total / clear: empty; the bill itself is the answer.
    lines: list[VoiceLine]
