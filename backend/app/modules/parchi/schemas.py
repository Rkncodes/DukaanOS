from pydantic import BaseModel, Field

from app.core.types import QuantityOut
from app.modules.catalog.schemas import ProductRead
from app.modules.vision.schemas import MatchState  # the same four outcomes as every recognized input


class ParchiLine(BaseModel):
    """One written line and how it maps onto this merchant's catalogue.
    Nothing is added to a cart until the merchant confirms."""

    id: str  # stable within one result, for the UI
    raw_text: str  # the line as read from the photo
    description: str  # the product words of the line (the quantity removed)
    quantity: QuantityOut | None  # null: the line gives no reliable quantity; the merchant must enter it
    read_confidence: float | None = Field(ge=0, le=1)  # how sure the reader was of the text
    match: MatchState
    product: ProductRead | None  # set only when match == matched
    candidates: list[ProductRead]  # choices for low_confidence / ambiguous, best first
    match_confidence: float | None = Field(ge=0, le=1)  # share of the written words found in the product's name
    matched_words: list[str]  # why: the written words found in the product's name...
    unmatched_words: list[str]  # ...and the ones that were not


class ParchiResult(BaseModel):
    provider: str
    text: str  # everything that was read, line by line
    lines: list[ParchiLine]
