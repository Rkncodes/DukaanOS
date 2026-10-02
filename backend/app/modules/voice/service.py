"""Voice -> spoken items matched to *this merchant's* catalogue, for the merchant to review.

Speech-to-text happens in the browser; only its transcript arrives here. Read-only: nothing is
stored and no cart is touched. Confirmed items reach the bill through billing.service
(POST /carts/{id}/recognized-items, source=voice), like every other input.
"""

from sqlalchemy.orm import Session

from app.core.tenancy import TenantContext
from app.modules.catalog import service as catalog
from app.modules.catalog.schemas import ProductRead
from app.modules.parchi.parsing import parse_line  # a spoken item is read like a written line
from app.modules.parchi.resolve import Entry, resolve
from app.modules.vision.schemas import MatchState
from app.modules.voice.parsing import split_items
from app.modules.voice.schemas import VoiceLine, VoiceResult

MAX_LINES = 50  # as many as one confirmation may add (billing.schemas.ConfirmedItemsAdd)


def parse_transcript(db: Session, ctx: TenantContext, transcript: str) -> VoiceResult:
    transcript = " ".join(transcript.split())
    products = catalog.list_products(db, ctx)  # this merchant's active products only
    by_id = {p.id: p for p in products}
    entries = [Entry(p.id, p.name) for p in products]

    parsed = (parse_line(item) for item in split_items(transcript, [p.name for p in products]))
    lines = []
    for index, line in enumerate([p for p in parsed if p is not None][:MAX_LINES]):
        found = resolve(line, entries)
        chosen = [ProductRead.model_validate(by_id[c.key]) for c in found.candidates]
        matched = found.state == MatchState.MATCHED
        lines.append(
            VoiceLine(
                id=f"v{index}",
                raw_text=line.raw_text,
                description=found.description,
                quantity=found.quantity,
                match=found.state,
                product=chosen[0] if matched else None,
                candidates=[] if matched else chosen,
                match_confidence=found.confidence,
                matched_words=list(found.matched_words),
                unmatched_words=list(found.unmatched_words),
            )
        )
    return VoiceResult(transcript=transcript, lines=lines)
