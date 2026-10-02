"""Vision -> catalog matching.

The provider says what it saw; this decides which of *this merchant's* products that
could be. It never chooses between several candidates and never invents products.
Confirmed items reach the cart through billing.service, like every other input.
"""

import uuid
from dataclasses import dataclass
from io import BytesIO

from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import DomainError, DomainValidationError, NotFound
from app.core.tenancy import TenantContext, get_owned, scoped
from app.integrations.types import IntegrationNotConfigured, RecognizedItem
from app.integrations.vision import CatalogAwareRecognizer, FrameRecognizer, ProductRecognizer, ReferenceEmbedder
from app.modules.catalog import service as catalog
from app.modules.catalog.models import Product
from app.modules.catalog.schemas import ProductRead
from app.modules.vision import matching
from app.modules.vision.matching import MAX_CANDIDATES, Decision, Entry, MatchingConfig
from app.modules.vision.models import ProductReferenceImage
from app.modules.vision.schemas import BoundingBoxRead, Detection, DetectionEvidence, MatchState, VisionResult

LOW_CONFIDENCE = 0.6  # name-hint providers: below this a single match still needs the merchant's pick
MAX_REFERENCES_PER_PRODUCT = 5
THUMBNAIL_SIDE = 256
UNKNOWN_LABEL = "Unknown product"
UNCLEAR_LABEL = "Unclear product"


class VisionUnavailable(DomainError):
    status_code = 503
    code = "vision_unavailable"


class VisionFailed(DomainError):
    """The provider is configured but inference failed on this image."""

    status_code = 502
    code = "vision_failed"


def _run(call, unavailable: str):
    """Provider call with clean errors: never a silent fallback, never a bare 500."""
    try:
        return call()
    except IntegrationNotConfigured as exc:
        raise VisionUnavailable(f"{unavailable}: {exc}") from exc
    except Exception as exc:
        raise VisionFailed("The vision provider could not process this image") from exc


@dataclass(frozen=True)
class Match:
    state: MatchState
    product: Product | None
    candidates: list[Product]


def _match_name(hint: str, products: list[Product]) -> tuple[Product | None, list[Product]]:
    """Returns (the single full match or None, ranked candidates). A product is a candidate
    when it shares a word with the hint, and a full match when it contains every hint word.
    A product whose whole name equals the hint wins outright ("Cola 750ml" vs "Cola 750ml Diet")."""
    exact = [p for p in products if p.name.strip().lower() == hint.strip().lower()]
    if len(exact) == 1:
        return exact[0], []
    wanted = matching.tokens(hint)
    if not wanted:
        return None, []
    scored = []
    for product in products:
        score = len(wanted & matching.tokens(product.name)) / len(wanted)
        if score > 0:
            scored.append((score, product))
    scored.sort(key=lambda sp: (-sp[0], sp[1].name))
    full = [p for s, p in scored if s == 1]
    return (full[0] if len(full) == 1 else None), [p for _, p in scored]


def match_item(db: Session, ctx: TenantContext, item: RecognizedItem, products: list[Product]) -> Match:
    """For providers that name what they saw (product id, barcode or a name hint).
    `products` must be this merchant's active catalog (catalog.list_products)."""
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


# ---- reference images (a merchant's photos of a product's real packaging) ----


def _references(db: Session, ctx: TenantContext, model: str | None) -> dict[uuid.UUID, list[tuple[float, ...]]]:
    """This merchant's reference embeddings made by `model`, by product."""
    by_product: dict[uuid.UUID, list[tuple[float, ...]]] = {}
    if model is None:
        return by_product
    rows = db.execute(
        select(ProductReferenceImage.product_id, ProductReferenceImage.embedding).where(
            ProductReferenceImage.merchant_id == ctx.merchant_id, ProductReferenceImage.model == model
        )
    )
    for product_id, embedding in rows:
        by_product.setdefault(product_id, []).append(tuple(embedding))
    return by_product


def list_reference_images(db: Session, ctx: TenantContext, product_id: uuid.UUID) -> list[ProductReferenceImage]:
    catalog.get_product(db, ctx, product_id)  # another merchant's product is a 404
    return list(
        db.scalars(
            scoped(ProductReferenceImage, ctx)
            .where(ProductReferenceImage.product_id == product_id)
            .order_by(ProductReferenceImage.created_at, ProductReferenceImage.id)
        )
    )


def get_reference_image(
    db: Session, ctx: TenantContext, product_id: uuid.UUID, reference_id: uuid.UUID
) -> ProductReferenceImage:
    reference = get_owned(db, ProductReferenceImage, reference_id, ctx, label="Reference photo")
    if reference.product_id != product_id:
        raise NotFound("Reference photo not found")
    return reference


def _thumbnail(image: bytes) -> bytes:
    with Image.open(BytesIO(image)) as img:
        small = img.convert("RGB")
        small.thumbnail((THUMBNAIL_SIDE, THUMBNAIL_SIDE))
        out = BytesIO()
        small.save(out, "JPEG", quality=80)
        return out.getvalue()


def add_reference_image(
    db: Session, ctx: TenantContext, recognizer: ProductRecognizer, product_id: uuid.UUID, image: bytes
) -> ProductReferenceImage:
    """`image` must already be validated (app.modules.vision.image). Only the embedding and a
    small thumbnail are stored."""
    product = catalog.get_product(db, ctx, product_id)
    count = db.scalar(
        select(func.count())
        .select_from(ProductReferenceImage)
        .where(ProductReferenceImage.merchant_id == ctx.merchant_id, ProductReferenceImage.product_id == product.id)
    )
    if count >= MAX_REFERENCES_PER_PRODUCT:
        raise DomainValidationError(f"A product can have at most {MAX_REFERENCES_PER_PRODUCT} reference photos")
    if not isinstance(recognizer, ReferenceEmbedder):
        raise VisionUnavailable("Reference photos are not available: the vision provider cannot compare images")
    model, embedding = _run(lambda: recognizer.embed_reference(image), "Reference photos are not available")
    reference = ProductReferenceImage(
        merchant_id=ctx.merchant_id,
        product_id=product.id,
        model=model,
        embedding=[float(v) for v in embedding],
        thumbnail=_thumbnail(image),
    )
    db.add(reference)
    db.flush()
    return reference


def delete_reference_image(db: Session, ctx: TenantContext, product_id: uuid.UUID, reference_id: uuid.UUID) -> None:
    db.delete(get_reference_image(db, ctx, product_id, reference_id))
    db.flush()


# ---- recognition ----


def _detection(index: int, item: RecognizedItem, **fields) -> Detection:
    return Detection(
        id=f"d{index}",
        barcode=item.barcode,
        quantity=item.quantity,
        bbox=BoundingBoxRead(**vars(item.bbox)) if item.bbox else None,
        **fields,
    )


def _from_decision(index: int, item: RecognizedItem, decision: Decision, by_id: dict[uuid.UUID, Product]) -> Detection:
    """Evidence-based providers: the decision names catalog products by id, nothing else."""
    chosen = [ProductRead.model_validate(by_id[s.key]) for s in decision.ranked]
    best = decision.best
    matched = decision.state == MatchState.MATCHED
    if decision.state == MatchState.UNMATCHED:
        label = UNKNOWN_LABEL
    elif decision.state == MatchState.AMBIGUOUS:
        # The choices are in `candidates`: sizes of one product, or otherwise no single name fits.
        label = decision.variants_of or UNCLEAR_LABEL
    else:
        label = chosen[0].name
    return _detection(
        index,
        item,
        label=label,
        confidence=best.score if best else None,
        match=decision.state,
        product=chosen[0] if matched else None,
        candidates=[] if matched else chosen,
        evidence=DetectionEvidence(
            visual=best.visual if best else 0.0,
            text=best.text if best else 0.0,
            reference=best.reference if best else 0.0,
            read_text=decision.read_text[:200],
        ),
    )


def _entries(db: Session, ctx: TenantContext, items: list[RecognizedItem], products: list[Product]) -> list[Entry]:
    """This merchant's catalog as the matcher sees it, with reference photos comparable to these items."""
    models = {i.evidence.embedding_model for i in items if i.evidence is not None and i.evidence.embedding}
    references = _references(db, ctx, models.pop()) if len(models) == 1 else {}
    return [Entry(p.id, p.name, tuple(references.get(p.id, ()))) for p in products]


def _observed(db: Session, ctx: TenantContext, provider, image: bytes, products: list[Product], config, tag: str):
    """Provider output for one image. With VISION_DEBUG_DIR set and a provider that can show its
    work, every stage is also written to disk (app.modules.vision.debug); the result is the same."""
    out_dir = settings.vision_debug_dir
    if out_dir is None or not hasattr(provider, "observe"):
        return None
    from app.modules.vision import debug

    seen = provider.observe(image)
    items = provider.items(seen)
    debug.save(out_dir, seen, [i.evidence for i in items], _entries(db, ctx, items, products), config, tag=tag)
    return items


def _detections(
    db: Session, ctx: TenantContext, items: list[RecognizedItem], products: list[Product], config: MatchingConfig
) -> list[Detection]:
    """Shared by photo and live-frame recognition: provider output -> matched detections."""
    with_evidence = [i for i, item in enumerate(items) if item.evidence is not None]
    decisions: dict[int, Decision] = {}
    if with_evidence:
        entries = _entries(db, ctx, items, products)
        decided = [(items[i].bbox, matching.decide(items[i].evidence, entries, config)) for i in with_evidence]
        # One physical packet = one detection, however many boxes the detector drew on it.
        decisions = {with_evidence[k]: decided[k][1] for k in matching.keep_one_per_object(decided, config)}

    by_id = {p.id: p for p in products}
    detections: list[Detection] = []
    for index, item in enumerate(items):
        if item.evidence is not None:
            if index in decisions:
                detections.append(_from_decision(len(detections), item, decisions[index], by_id))
            continue
        match = match_item(db, ctx, item, products)
        detections.append(
            _detection(
                len(detections),
                item,
                label=item.label or item.name_hint,
                confidence=item.confidence,
                match=match.state,
                product=ProductRead.model_validate(match.product) if match.product else None,
                candidates=[ProductRead.model_validate(p) for p in match.candidates],
            )
        )
    return detections


def _for_merchant(recognizer, products: list[Product]):
    """Catalog-aware providers compare what they see with this merchant's active product names."""
    if isinstance(recognizer, CatalogAwareRecognizer):
        return recognizer.for_catalog(tuple(p.name for p in products))
    return recognizer


def recognize(
    db: Session,
    ctx: TenantContext,
    recognizer: ProductRecognizer,
    image: bytes,
    *,
    config: MatchingConfig | None = None,
) -> VisionResult:
    products = catalog.list_products(db, ctx)
    provider = _for_merchant(recognizer, products)
    config = config or settings.vision_matching
    def observe():
        debugged = _observed(db, ctx, provider, image, products, config, "photo")
        return provider.recognize(image) if debugged is None else debugged

    items = _run(observe, "Photo recognition is not set up for this store")
    return VisionResult(
        provider=recognizer.name,
        is_mock=recognizer.is_mock,
        detections=_detections(db, ctx, items, products, config),
    )


def recognize_frame(
    db: Session,
    ctx: TenantContext,
    recognizer: FrameRecognizer,
    image: bytes,
    *,
    sequence: int,
    config: MatchingConfig | None = None,
) -> VisionResult:
    products = catalog.list_products(db, ctx)
    provider = _for_merchant(recognizer, products)
    config = config or settings.vision_matching

    def observe():
        debugged = _observed(db, ctx, provider, image, products, config, f"frame{sequence}")
        return provider.recognize_frame(image, sequence=sequence) if debugged is None else debugged

    items = _run(observe, "Live camera recognition is not set up for this store")
    return VisionResult(
        provider=recognizer.name,
        is_mock=recognizer.is_mock,
        detections=_detections(db, ctx, items, products, config),
        sequence=sequence,
    )
