"""Parchi -> lines matched to *this merchant's* catalogue, for the merchant to review.

Read-only: the photo is not stored and no cart is touched. Confirmed lines reach the bill
through billing.service (POST /carts/{id}/recognized-items, source=parchi), like every other input.
"""

import math

from sqlalchemy.orm import Session

from app.core.errors import DomainError
from app.core.tenancy import TenantContext
from app.integrations.ocr import ParchiReader, ParchiText
from app.integrations.types import IntegrationNotConfigured
from app.modules.catalog import service as catalog
from app.modules.catalog.schemas import ProductRead
from app.modules.parchi.parsing import parse_lines
from app.modules.parchi.resolve import Entry, resolve
from app.modules.parchi.schemas import ParchiLine, ParchiResult
from app.modules.vision.schemas import MatchState

MAX_LINES = 50  # as many as one confirmation may add (billing.schemas.ConfirmedItemsAdd)


class ParchiUnavailable(DomainError):
    status_code = 503
    code = "parchi_unavailable"


class ParchiFailed(DomainError):
    """The reader is configured but could not process this photo."""

    status_code = 502
    code = "parchi_failed"


def _read(reader: ParchiReader, image: bytes) -> list[ParchiText]:
    """Reader call with clean errors and only well-formed lines: never a fallback, never a bare 500."""
    try:
        read = reader.read(image)
    except IntegrationNotConfigured as exc:
        raise ParchiUnavailable(f"Parchi reading is not set up for this store: {exc}") from exc
    except Exception as exc:
        raise ParchiFailed("The parchi could not be read from this photo") from exc
    if not isinstance(read, list):
        raise ParchiFailed("The parchi could not be read from this photo")
    lines = []
    for item in read:
        text = getattr(item, "text", None)
        if not isinstance(text, str) or not text.strip():
            continue
        confidence = getattr(item, "confidence", None)
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not math.isfinite(confidence):
            confidence = None
        lines.append(ParchiText(text.strip(), None if confidence is None else min(1.0, max(0.0, float(confidence)))))
    return lines


def read_parchi(db: Session, ctx: TenantContext, reader: ParchiReader, image: bytes) -> ParchiResult:
    """`image` must already be validated (app.modules.vision.image)."""
    read = _read(reader, image)
    products = catalog.list_products(db, ctx)  # this merchant's active products only
    by_id = {p.id: p for p in products}
    entries = [Entry(p.id, p.name) for p in products]
    confidence = {" ".join(t.text.split()): t.confidence for t in read}

    lines = []
    for index, parsed in enumerate(parse_lines([t.text for t in read])[:MAX_LINES]):
        found = resolve(parsed, entries, take_apart=True)  # a reader drops the narrow gaps of handwriting
        chosen = [ProductRead.model_validate(by_id[c.key]) for c in found.candidates]
        matched = found.state == MatchState.MATCHED
        lines.append(
            ParchiLine(
                id=f"l{index}",
                raw_text=parsed.raw_text,
                description=found.description,
                quantity=found.quantity,
                read_confidence=confidence.get(parsed.raw_text),
                match=found.state,
                product=chosen[0] if matched else None,
                candidates=[] if matched else chosen,
                match_confidence=found.confidence,
                matched_words=list(found.matched_words),
                unmatched_words=list(found.unmatched_words),
            )
        )
    return ParchiResult(provider=reader.name, text="\n".join(t.text for t in read), lines=lines)
