"""Voice -> spoken items matched to *this merchant's* catalogue, for the merchant to review.

Speech-to-text happens in the browser; only its transcript arrives here. Read-only: nothing is
stored and no cart is touched. Confirmed items reach the bill through billing.service
(POST /carts/{id}/recognized-items, source=voice), like every other input; a spoken "remove" or
"change the quantity" is carried out by the Counter through the cart's own item endpoints, after
the merchant confirms it.
"""

import re
import uuid

from sqlalchemy.orm import Session

from app.core.tenancy import TenantContext
from app.modules.billing import service as billing
from app.modules.catalog import service as catalog
from app.modules.catalog.models import Product
from app.modules.catalog.schemas import ProductRead
from app.modules.parchi.parsing import parse_line  # a spoken item is read like a written line
from app.modules.parchi.resolve import MAX_CANDIDATES, Entry, resolve
from app.modules.vision.matching import words
from app.modules.vision.schemas import MatchState
from app.modules.voice import language
from app.modules.voice.parsing import split_items
from app.modules.voice.schemas import VoiceLine, VoiceResult

MAX_LINES = 50  # as many as one confirmation may add (billing.schemas.ConfirmedItemsAdd)
_NEW_QUANTITY = re.compile(r"^(.*\S)\s+(\d+(?:\.\d+)?)$")


MAX_ENDING = 2  # consonants a language may join onto a name ("मॅगीची", "ম্যাগির": Maggi's)


def _sounds_like(description: str, products: list[Product], *, tamil: bool = False) -> list[Product]:
    """Products whose name has, for every word that was said, a word that sounds the same (and
    every number exactly as said). For names heard in an Indian language, which no spelling can
    be compared with. A said word may carry a short ending after the name's sound; heard in
    Tamil, hard and soft consonants count as one. Only ever offered to the merchant."""
    said = words(description)
    if not any(not w[0].isdigit() for w in said):
        return []

    def heard(word: str, sounds: set[str]) -> bool:
        s = language.sound(word, hard_and_soft_alike=tamil)
        return any(s == n or (len(n) >= 2 and s.startswith(n) and len(s) - len(n) <= MAX_ENDING) for n in sounds)

    found = []
    for product in products:
        name_words = words(product.name)
        sounds = {language.sound(n, hard_and_soft_alike=tamil) for n in name_words if not n[0].isdigit()} - {""}
        if all((w in name_words) if w[0].isdigit() else heard(w, sounds) for w in said):
            found.append(product)
    return found[:MAX_CANDIDATES]


def _line(index: int, item: str, products: list[Product]) -> VoiceLine | None:
    entries = [Entry(p.id, p.name) for p in products]
    by_id = {p.id: p for p in products}
    parsed = parse_line(language.transliterate(item), raw_text=item)
    if parsed is None:
        return None
    found = resolve(parsed, entries)
    chosen = [by_id[c.key] for c in found.candidates]
    state, confidence = found.state, found.confidence
    if state != MatchState.MATCHED and language.in_indian_script(item):
        # A name said in Hindi, Marathi, Bengali, Tamil or Telugu: what every word of it sounds
        # like tells more than a chance spelling.
        alike = _sounds_like(found.description, products, tamil=language.is_tamil(item))
        if alike:  # a name that sounds alike is a suggestion, whether one product has it or several
            chosen = alike
            state = MatchState.LOW_CONFIDENCE if len(chosen) == 1 else MatchState.AMBIGUOUS
            confidence = None
    matched = state == MatchState.MATCHED
    return VoiceLine(
        id=f"v{index}",
        raw_text=parsed.raw_text,
        description=found.description,
        quantity=found.quantity,
        match=state,
        product=ProductRead.model_validate(chosen[0]) if matched else None,
        candidates=[] if matched else [ProductRead.model_validate(p) for p in chosen],
        match_confidence=confidence,
        matched_words=list(found.matched_words),
        unmatched_words=list(found.unmatched_words),
    )


def parse_transcript(db: Session, ctx: TenantContext, transcript: str, cart_id: uuid.UUID | None = None) -> VoiceResult:
    transcript = " ".join(transcript.split())
    intent, own_words = language.command(transcript)
    if intent in ("total", "clear"):
        return VoiceResult(transcript=transcript, intent=intent, lines=[])

    products = catalog.list_products(db, ctx)  # this merchant's active products only
    if intent in ("remove", "set_quantity"):
        # About what is on the open bill: nothing else in the catalogue can be meant.
        on_bill = {i.product_id for i in billing.get_cart(db, ctx, cart_id).items} if cart_id else set()
        products = [p for p in products if p.id in on_bill]

    lines: list[VoiceLine] = []
    for item in split_items(transcript, [p.name for p in products], own_words):
        if intent == "set_quantity":  # the number said with "quantity" is the quantity, whatever the name contains
            item = _NEW_QUANTITY.sub(r"\1 x \2", item)
        line = _line(len(lines), item, products)
        if line is not None:
            lines.append(line)
        if len(lines) == MAX_LINES:
            break
    return VoiceResult(transcript=transcript, intent=intent, lines=lines)
