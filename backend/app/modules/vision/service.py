"""Vision -> catalog matching.

The provider says what it saw; this decides which of *this merchant's* products that
could be. It never chooses between several candidates and never invents products.
Confirmed items reach the cart through billing.service, like every other input.
"""

import re
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.errors import DomainError, NotFound
from app.core.tenancy import TenantContext
from app.integrations.types import IntegrationNotConfigured, RecognizedItem
from app.integrations.vision import FrameRecognizer, ProductRecognizer
from app.modules.catalog import service as catalog
from app.modules.catalog.models import Product
from app.modules.catalog.schemas import ProductRead
from app.modules.vision.schemas import BoundingBoxRead, Detection, MatchState, VisionResult

LOW_CONFIDENCE = 0.6  # below this a single match still needs the merchant's explicit pick
MAX_CANDIDATES = 5

# Packaging words say nothing about which product it is.
_NOISE = {"a", "an", "the", "of", "pack", "packet", "box", "bottle", "tube", "can", "jar", "bag", "pouch"}
_UNIT = re.compile(r"(\d+(?:\.\d+)?)\s*(ml|l|g|gm|kg|pcs)\b")


class VisionUnavailable(DomainError):
    status_code = 503
    code = "vision_unavailable"


def _tokens(text: str) -> set[str]:
    text = _UNIT.sub(r"\1\2", text.lower())  # "750 ml" -> "750ml"
    return {t for t in re.split(r"[^a-z0-9.]+", text) if t and t not in _NOISE}


@dataclass(frozen=True)
class Match:
    state: MatchState
    product: Product | None
    candidates: list[Product]


def _match_name(hint: str, products: list[Product]) -> tuple[Product | None, list[Product]]:
    """Returns (the single full match or None, ranked candidates). A product is a candidate
    when it shares a word with the hint, and a full match when it contains every hint word."""
    wanted = _tokens(hint)
    if not wanted:
        return None, []
    scored = []
    for product in products:
        score = len(wanted & _tokens(product.name)) / len(wanted)
        if score > 0:
            scored.append((score, product))
    scored.sort(key=lambda sp: (-sp[0], sp[1].name))
    full = [p for s, p in scored if s == 1]
    return (full[0] if len(full) == 1 else None), [p for _, p in scored]


def match_item(db: Session, ctx: TenantContext, item: RecognizedItem, products: list[Product]) -> Match:
    """`products` must be this merchant's active catalog (catalog.list_products)."""
    product: Product | None = None
    candidates: list[Product] = []
    if item.product_id is not None:
        try:
            product = catalog.get_product(db, ctx, item.product_id)  # other merchants' ids 404
        except NotFound:
            product = None
        if product is not None and not product.is_active:
            product = None
    elif item.barcode:
        product = catalog.find_by_barcode(db, ctx, item.barcode)
    elif item.name_hint:
        product, candidates = _match_name(item.name_hint, products)

    if product is not None:
        if item.confidence is not None and item.confidence < LOW_CONFIDENCE:
            return Match(MatchState.LOW_CONFIDENCE, None, [product])
        return Match(MatchState.MATCHED, product, [])
    if candidates:
        return Match(MatchState.AMBIGUOUS, None, candidates[:MAX_CANDIDATES])
    return Match(MatchState.UNMATCHED, None, [])


def _detections(db: Session, ctx: TenantContext, items: list[RecognizedItem]) -> list[Detection]:
    """Shared by photo and live-frame recognition: provider output -> matched detections."""
    products = catalog.list_products(db, ctx)
    detections = []
    for index, item in enumerate(items):
        match = match_item(db, ctx, item, products)
        detections.append(
            Detection(
                id=f"d{index}",
                label=item.name_hint,
                barcode=item.barcode,
                quantity=item.quantity,
                confidence=item.confidence,
                bbox=BoundingBoxRead(**vars(item.bbox)) if item.bbox else None,
                match=match.state,
                product=ProductRead.model_validate(match.product) if match.product else None,
                candidates=[ProductRead.model_validate(p) for p in match.candidates],
            )
        )
    return detections


def recognize(db: Session, ctx: TenantContext, recognizer: ProductRecognizer, image: bytes) -> VisionResult:
    try:
        items = recognizer.recognize(image)
    except IntegrationNotConfigured as exc:
        raise VisionUnavailable("Photo recognition is not set up for this store") from exc
    return VisionResult(
        provider=recognizer.name, is_mock=recognizer.is_mock, detections=_detections(db, ctx, items)
    )


def recognize_frame(
    db: Session, ctx: TenantContext, recognizer: FrameRecognizer, image: bytes, *, sequence: int
) -> VisionResult:
    try:
        items = recognizer.recognize_frame(image, sequence=sequence)
    except IntegrationNotConfigured as exc:
        raise VisionUnavailable("Live camera recognition is not set up for this store") from exc
    return VisionResult(
        provider=recognizer.name,
        is_mock=recognizer.is_mock,
        detections=_detections(db, ctx, items),
        sequence=sequence,
    )
