"""Real vision provider boundary and catalog-grounded matching through the API.

The provider pipeline (locate + read text -> per-box evidence) is tested with small stand-in
stages, so CI never needs torch or model weights; the stand-ins script *observations* (scores,
text, embeddings), never decisions. Which catalog product a box is - or that it is none - is
always decided by the code under test. The real models run only in the opt-in smoke tests at
the bottom (VISION_REAL_SMOKE=1 + `uv sync --extra vision`).
"""

import json
import math
import os
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

import app.integrations.vision_real as vision_real_module
from app.core.config import Settings, settings
from app.core.enums import InputSource
from app.integrations.types import BoundingBox, IntegrationNotConfigured
from app.integrations.vision import (
    CatalogAwareRecognizer,
    NotConfiguredRecognizer,
    ReferenceEmbedder,
    build_frame_recognizer,
    build_recognizer,
)
from app.integrations.vision_real import (
    DEFAULT_PROMPTS,
    UNKNOWN,
    Identification,
    OwlVitLocator,
    RealLiveRecognizer,
    RealVisionConfig,
    Region,
    TextLine,
    _Models,
    crop_rect,
    lines_inside,
    load_prompts,
    parse_rapidocr,
    real_recognizer,
    relative_scores,
    text_classes,
)
from app.main import app
from app.modules.billing import service as billing
from app.modules.vision.matching import MatchingConfig
from app.modules.vision.router import get_frame_recognizer, get_recognizer
from tests.conftest import create_cart, create_product
from tests.test_vision import image_bytes, seed_demo_catalog

FRAMES = "/api/v1/vision/frames"
MAGGI = "Maggi 2-Minute Noodles 70g"
LAYS = "Lays Classic Salted 52g"
PARLE = "Parle-G Biscuits 250g"
MODEL = "fake-embedder"


def colour_embedding(image: Image.Image) -> tuple[float, ...]:
    """A real function of the pixels: the crop's mean colour, normalized."""
    r, g, b = image.convert("RGB").resize((1, 1)).getpixel((0, 0))
    norm = math.sqrt(r * r + g * g + b * b) or 1.0
    return (r / norm, g / norm, b / norm)


class FakeLocator:
    def __init__(self, *regions: Region):
        self.regions = list(regions)

    def locate(self, image: Image.Image) -> list[Region]:
        return self.regions


class FakeReader:
    def __init__(self, *lines: TextLine):
        self.lines = list(lines)

    def read(self, image: Image.Image) -> list[TextLine]:
        return self.lines


class FakeIdentifier:
    """Returns scripted visual scores per box (observations) and records the labels it was given.
    Embeddings are computed from the actual crop pixels."""

    embedding_model = MODEL

    def __init__(self, *found: dict[str, float] | Exception):
        self.found = list(found)
        self.labels_seen: list[tuple[str, ...]] = []
        self.calls = 0

    def identify(self, image: Image.Image, regions: list[Region], labels: tuple[str, ...]) -> list[Identification]:
        self.calls += 1
        self.labels_seen.append(labels)
        results = []
        for region, scores in zip(regions, self.found + [{}] * len(regions), strict=False):
            if isinstance(scores, Exception):
                raise scores
            visual = tuple(sorted(scores.items(), key=lambda kv: -kv[1]))
            crop = vision_real_module.crop(image, region.box, pad=0)
            results.append(Identification(visual, max(0.0, 1 - sum(scores.values())), colour_embedding(crop)))
        return results

    def embed(self, image: Image.Image) -> tuple[float, ...]:
        return colour_embedding(image)


def region(x, y, w, h, score=0.5) -> Region:
    return Region(BoundingBox(x, y, w, h), score)


def line(text, x, y, w=0.1, h=0.05, score=0.95) -> TextLine:
    return TextLine(text, BoundingBox(x, y, w, h), score)


BOX = region(0.1, 0.1, 0.3, 0.3)
IN_BOX = (0.15, 0.2)  # a text position whose centre is inside BOX


def recognizer(locator, identifier, reader=None, **kw) -> RealLiveRecognizer:
    return RealLiveRecognizer(locator, identifier, reader, name="fake-real", **kw)


def one_box(scores: dict[str, float], *text: str) -> RealLiveRecognizer:
    """A provider that sees one packet with these visual scores and this printed text."""
    reader = FakeReader(*[line(t, *IN_BOX) for t in text]) if text else None
    return recognizer(FakeLocator(BOX), FakeIdentifier(scores), reader)


def use_real(fake: RealLiveRecognizer) -> None:
    app.dependency_overrides[get_frame_recognizer] = lambda: fake  # cleared by make_client
    app.dependency_overrides[get_recognizer] = lambda: fake


def solid(colour=(200, 30, 30), size=(64, 48)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, colour).save(buf, "PNG")
    return buf.getvalue()


def send_frame(client, sequence: int = 0, image: bytes | None = None):
    image = solid() if image is None else image
    return client.post(FRAMES, files={"image": ("f.png", image, "image/png")}, data={"sequence": str(sequence)})


def detections(client, **kw) -> list[dict]:
    res = send_frame(client, **kw)
    assert res.status_code == 200, res.text
    return res.json()["detections"]


# ---- no products in the provider; prompts; selection ----


def test_provider_and_prompts_contain_no_products():
    raw = json.loads(DEFAULT_PROMPTS.read_text(encoding="utf-8"))
    assert set(raw) - {"_comment"} == {"locate_prompts", "class_templates", "other_prompts"}
    assert all("{name}" in t for t in raw["class_templates"])
    runtime = [Path(vision_real_module.__file__), DEFAULT_PROMPTS]
    runtime += [Path(vision_real_module.__file__).parents[1] / "modules" / "vision" / f for f in ("matching.py", "service.py")]
    source = "".join(p.read_text(encoding="utf-8") for p in runtime).lower()
    for brand in ("Maggi", "Doritos", "Britannia", "Croissant", "Cadbury", "Dettol", "Kurkure", "Lays", "Coke", "Parle"):
        assert brand.lower() not in source, brand
    assert "sequence %" not in source and "frame_number" not in source  # nothing is decided by the frame counter


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        json.dumps({"locate_prompts": ["p"], "other_prompts": ["o"]}),
        json.dumps({"locate_prompts": ["p"], "class_templates": ["no placeholder"], "other_prompts": ["o"]}),
        json.dumps({"locate_prompts": [], "class_templates": ["a {name}"], "other_prompts": ["o"]}),
    ],
)
def test_invalid_prompts_fail_clearly(tmp_path: Path, content):
    path = tmp_path / "prompts.json"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(IntegrationNotConfigured):
        load_prompts(path)


def test_classes_are_built_from_the_given_catalog_names():
    prompts = load_prompts()
    texts, owners = text_classes(prompts, ("Masala Oats 40g", "Rose Soap"))
    assert texts[: len(prompts.templates)] == [t.format(name="Masala Oats 40g") for t in prompts.templates]
    assert owners.count("Masala Oats 40g") == owners.count("Rose Soap") == len(prompts.templates)
    assert owners[-len(prompts.other) :] == [None] * len(prompts.other)  # the "something else" competitors

    probs = relative_scores(["A", "A", "B", None], [2.0, 5.0, 1.0, 3.0])  # best prompt per owner, softmax
    assert max(probs, key=lambda o: probs[o]) == "A" and abs(sum(probs.values()) - 1) < 1e-9


def test_real_provider_is_lazy_catalog_aware_and_selected_by_config():
    config = RealVisionConfig()
    real = build_frame_recognizer("real", config)
    assert isinstance(real, RealLiveRecognizer) and real.is_mock is False
    assert isinstance(real, CatalogAwareRecognizer) and isinstance(real, ReferenceEmbedder)
    assert build_recognizer("real", config) is real  # one shared instance serves photos and frames
    assert real.locator.models._loaded is None  # no model loaded until the first frame
    assert real.labels == () and real.reader is not None  # knows no products by itself; reads text by default
    assert real_recognizer(RealVisionConfig(ocr=False)).reader is None

    # No mock exists: "none" (or any unknown name) is a clear "switched off", never fake detections.
    for name in ("none", "mock"):
        assert isinstance(build_frame_recognizer(name), NotConfiguredRecognizer)
    assert not isinstance(NotConfiguredRecognizer(), CatalogAwareRecognizer)


def test_settings_default_to_the_real_provider_and_reject_mock(monkeypatch):
    assert Settings(_env_file=None).vision_provider == "real"  # default is real, not mock
    with pytest.raises(ValueError):
        Settings(_env_file=None, vision_provider="mock")  # the mock is gone from configuration
    monkeypatch.setattr(settings, "vision_provider", "real")
    assert isinstance(get_frame_recognizer(), RealLiveRecognizer)
    assert isinstance(get_recognizer(), RealLiveRecognizer)
    monkeypatch.setattr(settings, "vision_provider", "none")
    assert isinstance(get_frame_recognizer(), NotConfiguredRecognizer)


def test_matching_thresholds_come_from_the_environment(monkeypatch):
    assert Settings(_env_file=None).vision_matching == MatchingConfig()  # documented defaults
    monkeypatch.setenv("VISION_MATCH_SCORE", "0.9")
    monkeypatch.setenv("VISION_MIN_SCORE", "0.5")
    monkeypatch.setenv("VISION_MATCH_MARGIN", "0.3")
    monkeypatch.setenv("VISION_REAL_OCR", "false")
    configured = Settings(_env_file=None)
    assert configured.vision_matching == MatchingConfig(match_score=0.9, min_score=0.5, margin=0.3)
    assert configured.real_vision.ocr is False
    with pytest.raises(ValueError, match="VISION_MIN_SCORE"):
        Settings(_env_file=None, vision_min_score=0.8, vision_match_score=0.6)
    with pytest.raises(ValueError, match="VISION_REFERENCE_FLOOR"):
        Settings(_env_file=None, vision_reference_floor=0.9, vision_reference_strong=0.8)


def test_switched_off_vision_is_a_clear_503(client_a, monkeypatch):
    monkeypatch.setattr(settings, "vision_provider", "none")
    res = send_frame(client_a)
    assert res.status_code == 503 and res.json()["error"]["code"] == "vision_unavailable"
    assert "VISION_PROVIDER=none" in res.json()["error"]["message"]


def test_missing_ml_dependencies_fail_clearly(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_torch(name, *args, **kwargs):
        if name == "torch" or name.startswith("transformers"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_torch)
    with pytest.raises(IntegrationNotConfigured, match="uv sync --extra vision"):
        _Models(RealVisionConfig()).get()


# ---- /vision/frames contract (unchanged) ----


@pytest.mark.parametrize(
    ("form", "data", "content_type", "status"),
    [
        ({"sequence": "-1"}, None, "image/jpeg", 422),
        ({"sequence": "0"}, b"not an image", "image/jpeg", 422),
        ({"sequence": "0"}, None, "text/plain", 422),
        ({}, None, "image/jpeg", 200),  # sequence defaults to 0
    ],
)
def test_frame_request_validation(client_a, form, data, content_type, status):
    use_real(recognizer(FakeLocator(), FakeIdentifier()))
    image = image_bytes("JPEG") if data is None else data
    res = client_a.post(FRAMES, files={"image": ("f.jpg", image, content_type)}, data=form)
    assert res.status_code == status, res.text


def test_frames_require_login_and_echo_the_sequence(client_a, make_client):
    use_real(recognizer(FakeLocator(), FakeIdentifier()))
    assert send_frame(make_client()).status_code == 401
    body = send_frame(client_a, 41).json()
    assert body["sequence"] == 41 and body["detections"] == []  # nothing in the image -> nothing detected


def test_detections_follow_the_image_not_the_frame_number(client_a):
    """Same frame number, different image -> different result (the image decides, not the sequence)."""
    seed_demo_catalog(client_a)

    class ReadsPixels:  # locator stand-in that looks at the frame: a box only where it is red
        def locate(self, image):
            r, g, _ = image.convert("RGB").getpixel((0, 0))
            return [region(0.1, 0.1, 0.3, 0.3, 0.9)] if r > 150 and g < 100 else []

    use_real(recognizer(ReadsPixels(), FakeIdentifier({MAGGI: 0.9})))
    red, blue = solid((200, 30, 30)), solid((20, 40, 200))
    for image, expected in ((red, [MAGGI]), (blue, []), (red, [MAGGI])):
        assert [d["label"] for d in detections(client_a, sequence=5, image=image)] == expected


# ---- provider output: observations, not decisions ----


def test_provider_returns_evidence_per_box_and_never_a_product():
    identifier = FakeIdentifier({MAGGI: 0.83, LAYS: 0.05}, {LAYS: 0.91}, {"Some Other Store's Product": 0.9})
    reader = FakeReader(
        line("NOODLES", 0.15, 0.3), line("MASALA", 0.2, 0.45), line("SALTED", 0.55, 0.3), line("blurry", 0.2, 0.25, score=0.2)
    )
    fake = recognizer(
        FakeLocator(region(0.1, 0.2, 0.3, 0.4, 0.62), region(0.5, 0.1, 0.2, 0.5, 0.5), region(0.75, 0.6, 0.2, 0.3, 0.4)),
        identifier,
        reader,
    ).for_catalog((MAGGI, LAYS, " "))

    maggi, lays, other = fake.recognize_frame(solid(), sequence=7)
    assert identifier.labels_seen == [(MAGGI, LAYS)]  # blank names dropped
    for item in (maggi, lays, other):  # the provider proposes no product, name or barcode
        assert item.source == InputSource.VISION and item.quantity == 1  # one box = one physical packet
        assert (item.product_id, item.barcode, item.name_hint, item.confidence) == (None, None, None, None)
        assert item.label == UNKNOWN and item.evidence.embedding_model == MODEL and len(item.evidence.embedding) == 3
    assert maggi.bbox == BoundingBox(0.1, 0.2, 0.3, 0.4) and maggi.evidence.locate_score == 0.62
    assert maggi.evidence.visual == ((MAGGI, 0.83), (LAYS, 0.05))
    assert maggi.evidence.text == "NOODLES MASALA"  # lines inside the box, top to bottom; unreadable ones dropped
    assert lays.evidence.text == "SALTED" and other.evidence.text == ""
    assert other.evidence.visual == ()  # a label the provider was not given is never reported
    assert fake.recognize(solid()) == fake.recognize_frame(solid(), sequence=0)  # the sequence changes nothing


def test_boxes_are_clipped_filtered_deduplicated_and_capped():
    fake = recognizer(
        FakeLocator(
            region(-0.1, 0.9, 0.3, 0.3, 0.9),  # partly outside the frame -> clipped
            region(-0.08, 0.88, 0.3, 0.3, 0.8),  # same packet again -> dropped (overlap)
            region(0.5, 0.5, 0.2, 0.2, 0.05),  # too unlikely to be a product -> dropped
            region(0.99, 0.2, 0.3, 0.3, 0.7),  # almost entirely outside -> dropped
            region(0.3, 0.3, 0.2, float("nan"), 0.9),  # malformed box -> dropped
            region(0.3, 0.3, 0.2, 0.2, float("nan")),  # malformed score -> dropped
            *[region(0.05 * i, 0.05, 0.04, 0.04, 0.6) for i in range(1, 12)],
        ),
        FakeIdentifier(),
        max_items=4,
    ).for_catalog((MAGGI,))
    items = fake.recognize(solid())
    assert len(items) == 4
    first = items[0].bbox
    assert (first.x, first.y, first.width, first.height) == (0.0, 0.9, 0.2, 0.1)
    for item in items:
        b = item.bbox
        assert 0 <= b.x <= 1 and 0 <= b.y <= 1 and b.x + b.width <= 1.0001 and b.y + b.height <= 1.0001


class ScriptedDetectorOutput:
    """Stands in for the loaded torch models: hands back raw detector output in the model's own
    format - (centre x, centre y, width, height) as fractions of the model input."""

    config = RealVisionConfig()

    def __init__(self, scores: list[float], boxes: list[list[float]]):
        self.output = (scores, boxes)

    def run(self, infer):
        return self.output


PACKET_W, PACKET_H = 420, 222


@pytest.mark.parametrize(
    ("size", "left", "top"),
    [
        ((960, 540), 270, 30),  # a webcam frame: packet in the upper part...
        ((960, 540), 270, 160),  # ...the middle...
        ((960, 540), 270, 300),  # ...and the lower part (this one used to become a sliver at the bottom edge)
        ((960, 540), 0, 318),  # touching the left and bottom edges
        ((540, 960), 60, 600),  # portrait
        ((640, 640), 100, 200),  # square
    ],
)
def test_detector_boxes_land_on_the_packet_whatever_the_frame_shape(size, left, top):
    """Regression: the detector's processor stretches the whole frame to its square input (it does
    not pad), so its box fractions are fractions of the frame. Treating them as fractions of a
    padded square pushed every box down and made it 1.78x taller on a 16:9 frame."""
    w, h = size
    right, bottom = left + PACKET_W, top + PACKET_H
    centre_box = [(left + right) / 2 / w, (top + bottom) / 2 / h, PACKET_W / w, PACKET_H / h]
    locator = OwlVitLocator(ScriptedDetectorOutput([0.6], [centre_box]), ("a product",))
    logo = line("LOGO", (left + 150) / w, (top + 90) / h, 120 / w, 40 / h)  # printed on the packet
    elsewhere = line("POSTER", 0.02, 0.02, 0.05, 0.03) if top > 100 else line("POSTER", 0.02, 0.9, 0.05, 0.03)

    fake = recognizer(locator, FakeIdentifier({MAGGI: 0.9}), FakeReader(logo, elsewhere)).for_catalog((MAGGI,))
    seen = fake.observe(solid(size=size))
    [region] = seen.regions
    cut = crop_rect(size, region.box, pad=0)
    assert all(abs(got - want) <= 1 for got, want in zip(cut, (left, top, right, bottom), strict=True)), cut
    assert [t.text for t in lines_inside(region.box, list(seen.lines))] == ["LOGO"]  # its text, not the poster's
    [item] = fake.items(seen)
    assert item.evidence.text == "LOGO"


def test_a_box_inside_a_stronger_box_is_the_same_packet():
    """Seen on a real packet photo: a small box on the packet's artwork inside the packet's box."""
    fake = recognizer(
        FakeLocator(
            region(0.02, 0.01, 0.96, 0.9, 0.31), region(0.66, 0.71, 0.26, 0.2, 0.19), region(0.0, 0.92, 0.3, 0.08, 0.2)
        ),
        FakeIdentifier(),
    ).for_catalog((MAGGI, LAYS))
    assert [i.bbox.x for i in fake.recognize(solid())] == [0.02, 0.0]  # nested box dropped


def test_nothing_located_skips_identification():
    identifier = FakeIdentifier()
    assert recognizer(FakeLocator(), identifier).for_catalog((MAGGI,)).recognize(solid()) == []
    assert identifier.calls == 0


def test_malformed_ocr_output_is_skipped_not_fatal():
    good = [[[10, 10], [110, 10], [110, 30], [10, 30]], "TREAT", 0.97]
    result = [
        good,
        None,
        "garbage",
        [[[1, 1]], "short"],  # missing score
        [[[0, 0], [5, 0], [5, 5], ["x", 5]], "bad point", 0.9],
        [[[0, 0], [50, 0], [50, 20], [0, 20]], "   ", 0.9],  # blank text
        [[[0, 0], [50, 0], [50, 20], [0, 20]], "nan score", float("nan")],
        [[[0, 0], [50, 0], [50, 20], [0, 20]], 42, 0.9],  # text is not a string
    ]
    [only] = parse_rapidocr(result, (200, 100))
    assert only.text == "TREAT" and only.box == BoundingBox(0.05, 0.1, 0.5, 0.2) and only.score == 0.97
    assert parse_rapidocr(None, (200, 100)) == [] and parse_rapidocr([good], (0, 0)) == []


# ---- through the API: catalog-grounded decisions ----


def test_service_gives_the_provider_exactly_this_merchants_active_product_names(client_a, client_b):
    catalog = seed_demo_catalog(client_a)
    client_a.delete(f"/api/v1/products/{catalog['Colgate Strong Teeth 200g']['id']}")  # inactive
    create_product(client_b, name="Store B Secret Snack")
    identifier = FakeIdentifier({MAGGI: 0.9})
    use_real(recognizer(FakeLocator(BOX), identifier))

    assert send_frame(client_a).status_code == 200
    [labels] = identifier.labels_seen
    assert set(labels) == {p["name"] for p in catalog.values()} - {"Colgate Strong Teeth 200g"}
    assert "Store B Secret Snack" not in labels


def test_agreeing_look_and_text_match_with_catalog_name_and_price(client_a):
    catalog = seed_demo_catalog(client_a)
    use_real(one_box({MAGGI: 0.83, PARLE: 0.05}, "MAGGI", "2-MINUTE NOODLES"))
    body = send_frame(client_a, 3).json()
    assert body["provider"] == "fake-real" and body["is_mock"] is False and body["sequence"] == 3

    [d] = body["detections"]
    assert d["match"] == "matched" and d["label"] == MAGGI and d["candidates"] == []
    assert d["product"]["id"] == catalog[MAGGI]["id"]
    assert d["product"]["price"] == "14.00"  # from the catalog, not the model
    assert d["quantity"] == "1.000" and d["bbox"] == {"x": 0.1, "y": 0.1, "width": 0.3, "height": 0.3}
    assert d["confidence"] > 0.83  # combined evidence: the text adds to the look
    assert d["evidence"]["visual"] == 0.83 and d["evidence"]["text"] > 0.5 and d["evidence"]["reference"] == 0
    assert d["evidence"]["read_text"] == "MAGGI 2-MINUTE NOODLES"


def test_weak_top_candidate_is_never_forced_onto_a_catalog_product(client_a):
    """The reported failure: a chocolate bar 'matched' to an antiseptic at 0.23 vs 0.21."""
    create_product(client_a, name="Antiseptic Liquid 125ml")
    create_product(client_a, name="Caramel Bar 40g")
    use_real(one_box({"Antiseptic Liquid 125ml": 0.23, "Caramel Bar 40g": 0.21}))
    [d] = detections(client_a)
    assert d["match"] == "unmatched" and d["product"] is None and d["candidates"] == []
    assert d["label"] == UNKNOWN and d["confidence"] is None


def test_text_on_the_pack_overrules_a_weak_look(client_a):
    """Same weak look, but the pack's name was read: the product with the text wins; the
    nearest-looking product is not chosen."""
    create_product(client_a, name="Antiseptic Liquid 125ml")
    bar = create_product(client_a, name="Caramel Bar 40g", price="20.00")
    use_real(one_box({"Antiseptic Liquid 125ml": 0.23, "Caramel Bar 40g": 0.21}, "CARAMEL", "BAR"))
    [d] = detections(client_a)
    assert d["match"] == "matched" and d["product"]["id"] == bar["id"] and d["product"]["price"] == "20.00"

    # Partly read ("BAR" only): better supported than the other product, but not enough to preselect.
    use_real(one_box({"Antiseptic Liquid 125ml": 0.23, "Caramel Bar 40g": 0.21}, "BAR"))
    [d] = detections(client_a)
    assert d["match"] == "low_confidence" and d["product"] is None
    assert [c["id"] for c in d["candidates"]] == [bar["id"]]


def test_text_separates_products_the_look_confuses(client_a):
    croissant = create_product(client_a, name="Butter Croissant 45g", price="30.00")
    create_product(client_a, name="Glucose Biscuits 250g", price="25.00")
    look = {"Butter Croissant 45g": 0.54, "Glucose Biscuits 250g": 0.42}

    use_real(one_box(look))  # look alone: too close to call -> the merchant picks, nothing preselected
    [d] = detections(client_a)
    assert d["match"] == "ambiguous" and d["product"] is None and d["label"] == "Unclear product"
    assert [c["name"] for c in d["candidates"]] == ["Butter Croissant 45g", "Glucose Biscuits 250g"]  # best first
    assert {c["price"] for c in d["candidates"]} == {"30.00", "25.00"}  # catalog prices

    use_real(one_box(look, "BUTTER", "CROISSANT"))
    [d] = detections(client_a)
    assert d["match"] == "matched" and d["product"]["id"] == croissant["id"]


def test_modest_look_with_a_clear_lead_is_unsure_not_rejected_and_not_auto_added(client_a):
    chips = create_product(client_a, name="Nacho Chips 44g")
    create_product(client_a, name="Glucose Biscuits 250g")
    use_real(one_box({"Nacho Chips 44g": 0.52, "Glucose Biscuits 250g": 0.03}))
    [d] = detections(client_a)
    assert d["match"] == "low_confidence" and d["product"] is None and d["confidence"] == 0.52
    assert [c["id"] for c in d["candidates"]] == [chips["id"]]


def test_strong_look_contradicted_by_readable_text_is_not_preselected(client_a):
    """Looks like the catalog's noodles, but the pack says something else entirely."""
    noodles = create_product(client_a, name="Instant Noodles 70g")
    use_real(one_box({"Instant Noodles 70g": 0.9}))
    assert detections(client_a)[0]["match"] == "matched"  # nothing readable: the look decides

    use_real(one_box({"Instant Noodles 70g": 0.9}, "ZINGY", "RAMEN", "SPICY", "CHICKEN"))
    [d] = detections(client_a)
    assert d["match"] == "low_confidence" and [c["id"] for c in d["candidates"]] == [noodles["id"]]

    use_real(one_box({"Instant Noodles 70g": 0.9}, "INSTANT", "NOODLES", "NET WT 140g"))  # another size of it
    assert detections(client_a)[0]["match"] == "low_confidence"


def test_a_packet_that_is_not_in_the_catalog_is_unknown_not_the_nearest_product(client_a):
    seed_demo_catalog(client_a)
    # Looks vaguely like one catalog product; the pack's own text names none of them.
    use_real(one_box({PARLE: 0.6, MAGGI: 0.1}, "CHOCO", "WAFER", "ROLLS", "HAZELNUT"))
    [d] = detections(client_a)
    assert d["match"] == "unmatched" and d["product"] is None and d["candidates"] == []
    assert d["evidence"]["read_text"] == "CHOCO WAFER ROLLS HAZELNUT"


def test_duplicate_product_names_are_never_silently_resolved(client_a):
    a = create_product(client_a, name="Rose Soap", sku="A")
    b = create_product(client_a, name="Rose Soap", sku="B")
    use_real(one_box({"Rose Soap": 0.95}, "ROSE", "SOAP"))
    [d] = detections(client_a)
    assert d["match"] == "ambiguous" and {c["id"] for c in d["candidates"]} == {a["id"], b["id"]}


def test_size_variants_ask_which_size_until_the_size_is_read(client_a):
    small = create_product(client_a, name="Instant Noodles 35g", price="7.00")
    large = create_product(client_a, name="Instant Noodles 70g", price="14.00")
    for look in ({"Instant Noodles 35g": 0.68, "Instant Noodles 70g": 0.31}, {"Instant Noodles 35g": 0.45, "Instant Noodles 70g": 0.53}):
        use_real(one_box(look, "INSTANT", "NOODLES"))
        [d] = detections(client_a)
        assert d["match"] == "ambiguous" and d["product"] is None and d["label"] == "Instant Noodles"
        assert [(c["id"], c["price"]) for c in d["candidates"]] == [(small["id"], "7.00"), (large["id"], "14.00")]

    use_real(one_box({"Instant Noodles 35g": 0.45, "Instant Noodles 70g": 0.53}, "INSTANT", "NOODLES", "NET WT 35g"))
    [d] = detections(client_a)
    assert d["match"] == "matched" and d["product"]["id"] == small["id"] and d["product"]["price"] == "7.00"


def test_real_matching_respects_merchant_isolation(client_a, client_b):
    seed_demo_catalog(client_a)
    # Store B has no products: the same packet, look and text resolve to nothing for B.
    use_real(one_box({MAGGI: 0.95}, "MAGGI", "NOODLES"))
    assert detections(client_a)[0]["match"] == "matched"
    [b_view] = detections(client_b)
    assert b_view["label"] == UNKNOWN and b_view["match"] == "unmatched" and b_view["product"] is None

    b_maggi = create_product(client_b, name=MAGGI, price="15.00")  # same name, Store B's own product
    [b_view] = detections(client_b)
    assert b_view["product"]["id"] == b_maggi["id"] and b_view["product"]["price"] == "15.00"


# ---- one physical packet = one detection ----


def test_overlapping_boxes_of_the_same_product_are_one_packet(client_a):
    """The detector drew two partly overlapping boxes on one packet (IoU below its own NMS limit)."""
    seed_demo_catalog(client_a)
    fake = recognizer(
        FakeLocator(region(0.10, 0.10, 0.40, 0.40, 0.6), region(0.34, 0.10, 0.40, 0.40, 0.5)),
        FakeIdentifier({MAGGI: 0.9}, {MAGGI: 0.8}),
    )
    assert len(fake.for_catalog((MAGGI,)).recognize(solid())) == 2  # the provider really reports both
    use_real(fake)
    [d] = detections(client_a)
    assert d["match"] == "matched" and d["quantity"] == "1.000" and d["id"] == "d0"
    assert d["bbox"]["x"] == 0.1 and d["confidence"] == 0.9  # the better-supported box is kept


def test_two_separate_packets_of_the_same_product_are_two_detections(client_a):
    catalog = seed_demo_catalog(client_a)
    use_real(
        recognizer(
            FakeLocator(region(0.05, 0.1, 0.3, 0.4, 0.6), region(0.6, 0.1, 0.3, 0.4, 0.5)),
            FakeIdentifier({MAGGI: 0.9}, {MAGGI: 0.9}),
        )
    )
    found = detections(client_a)
    assert [d["product"]["id"] for d in found] == [catalog[MAGGI]["id"]] * 2
    assert [d["quantity"] for d in found] == ["1.000", "1.000"] and [d["id"] for d in found] == ["d0", "d1"]


def test_overlapping_boxes_of_different_products_are_both_kept(client_a):
    catalog = seed_demo_catalog(client_a)
    use_real(
        recognizer(
            FakeLocator(region(0.10, 0.10, 0.40, 0.40, 0.6), region(0.34, 0.10, 0.40, 0.40, 0.5)),
            FakeIdentifier({MAGGI: 0.9}, {PARLE: 0.9}),
        )
    )
    assert [d["product"]["id"] for d in detections(client_a)] == [catalog[MAGGI]["id"], catalog[PARLE]["id"]]


# ---- reference photos ----


def references_url(product: dict) -> str:
    return f"/api/v1/vision/products/{product['id']}/reference-images"


def add_reference(client, product: dict, image: bytes):
    return client.post(references_url(product), files={"image": ("ref.png", image, "image/png")})


RED, BLUE = (200, 30, 30), (20, 40, 200)


def test_reference_photos_are_stored_per_product_as_embedding_and_thumbnail(client_a, client_b):
    use_real(recognizer(FakeLocator(), FakeIdentifier()))
    soap = create_product(client_a, name="Rose Soap")
    res = add_reference(client_a, soap, solid(RED, (800, 600)))
    assert res.status_code == 201, res.text
    reference = res.json()
    assert set(reference) == {"id", "product_id", "created_at"} and reference["product_id"] == soap["id"]
    assert [r["id"] for r in client_a.get(references_url(soap)).json()] == [reference["id"]]

    thumb = client_a.get(f"{references_url(soap)}/{reference['id']}/thumbnail")
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"
    with Image.open(BytesIO(thumb.content)) as img:
        assert img.format == "JPEG" and max(img.size) == 256  # the original upload is not kept

    # Another merchant can neither see, add to, nor delete it.
    assert client_b.get(references_url(soap)).status_code == 404
    assert add_reference(client_b, soap, solid()).status_code == 404
    assert client_b.get(f"{references_url(soap)}/{reference['id']}/thumbnail").status_code == 404
    assert client_b.delete(f"{references_url(soap)}/{reference['id']}").status_code == 404

    other = create_product(client_a, name="Other")
    assert client_a.delete(f"{references_url(other)}/{reference['id']}").status_code == 404  # wrong product
    assert client_a.delete(f"{references_url(soap)}/{reference['id']}").status_code == 204
    assert client_a.get(references_url(soap)).json() == []


def test_reference_photo_uploads_are_validated_and_limited(client_a, make_client):
    use_real(recognizer(FakeLocator(), FakeIdentifier()))
    soap = create_product(client_a, name="Rose Soap")
    assert add_reference(make_client(), soap, solid()).status_code == 401
    bad = client_a.post(references_url(soap), files={"image": ("x.png", b"not an image", "image/png")})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_image"
    for _ in range(5):
        assert add_reference(client_a, soap, solid()).status_code == 201
    full = add_reference(client_a, soap, solid())
    assert full.status_code == 422 and "at most 5" in full.json()["error"]["message"]


def test_reference_photos_need_a_provider_that_can_compare_images(client_a):
    soap = create_product(client_a, name="Rose Soap")
    use_real(NotConfiguredRecognizer())
    res = add_reference(client_a, soap, solid())
    assert res.status_code == 503 and res.json()["error"]["code"] == "vision_unavailable"
    assert client_a.get(references_url(soap)).json() == []


def test_a_reference_photo_turns_an_unsure_look_into_a_match(client_a, client_b):
    red_bar = create_product(client_a, name="Caramel Bar 40g")
    create_product(client_a, name="Antiseptic Liquid 125ml")
    weak = {"Antiseptic Liquid 125ml": 0.23, "Caramel Bar 40g": 0.21}
    use_real(one_box(weak))
    assert detections(client_a, image=solid(RED))[0]["match"] == "unmatched"

    assert add_reference(client_a, red_bar, solid(RED)).status_code == 201  # "this is what it looks like"
    [d] = detections(client_a, image=solid(RED))
    assert d["match"] == "matched" and d["product"]["id"] == red_bar["id"] and d["evidence"]["reference"] == 1.0
    # The camera image decides: a packet that does not look like the reference gets no support from it.
    assert detections(client_a, image=solid(BLUE))[0]["match"] == "unmatched"

    # Store B's catalog has the same names but not Store A's reference photos.
    create_product(client_b, name="Caramel Bar 40g")
    create_product(client_b, name="Antiseptic Liquid 125ml")
    assert detections(client_b, image=solid(RED))[0]["match"] == "unmatched"


def test_a_product_with_reference_photos_is_not_preselected_when_the_packet_looks_different(client_a):
    noodles = create_product(client_a, name="Instant Noodles 70g")
    use_real(one_box({"Instant Noodles 70g": 0.9}))
    assert add_reference(client_a, noodles, solid(RED)).status_code == 201
    assert detections(client_a, image=solid(RED))[0]["match"] == "matched"
    [d] = detections(client_a, image=solid(BLUE))
    assert d["match"] == "low_confidence" and d["evidence"]["reference"] == 0


def test_references_from_another_embedding_model_are_ignored(client_a):
    bar = create_product(client_a, name="Caramel Bar 40g")
    use_real(one_box({"Caramel Bar 40g": 0.2}))
    assert add_reference(client_a, bar, solid(RED)).status_code == 201

    class NewerIdentifier(FakeIdentifier):
        embedding_model = "another-model"  # embeddings from different models are not comparable

    use_real(recognizer(FakeLocator(BOX), NewerIdentifier({"Caramel Bar 40g": 0.2})))
    assert detections(client_a, image=solid(RED))[0]["match"] == "unmatched"


# ---- recognition is read-only; billing goes through the existing path ----


def test_real_recognition_never_mutates_the_cart(client_a):
    catalog = seed_demo_catalog(client_a)
    cart = create_cart(client_a)
    use_real(one_box({MAGGI: 0.95}, "MAGGI"))
    for seq in range(10):
        assert send_frame(client_a, seq).status_code == 200
    photo = client_a.post("/api/v1/vision/recognize", files={"image": ("p.png", solid(), "image/png")})
    assert photo.status_code == 200 and photo.json()["detections"][0]["match"] == "matched"
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["items"] == []
    assert client_a.get(f"/api/v1/products/{catalog[MAGGI]['id']}").json()["stock_quantity"] == "50.000"


def test_confirming_a_real_detection_uses_add_item(client_a, monkeypatch):
    seed_demo_catalog(client_a)
    use_real(one_box({MAGGI: 0.95}, "MAGGI"))
    [d] = detections(client_a)

    calls = []
    original = billing.add_item
    monkeypatch.setattr(billing, "add_item", lambda *a, **k: calls.append(a[3:]) or original(*a, **k))
    cart = create_cart(client_a)
    res = client_a.post(
        f"/api/v1/carts/{cart['id']}/recognized-items",
        json={"source": "vision", "items": [{"product_id": d["product"]["id"], "quantity": "1"}]},
    )
    assert res.status_code == 200 and res.json()["subtotal"] == "14.00"
    assert [(str(pid), qty, source) for pid, qty, source in calls] == [(d["product"]["id"], 1, InputSource.VISION)]


def test_inference_errors_are_clean_502(client_a):
    use_real(recognizer(FakeLocator(BOX), FakeIdentifier(RuntimeError("CUDA OOM"))))
    res = send_frame(client_a)
    assert res.status_code == 502 and res.json()["error"]["code"] == "vision_failed"
    assert "CUDA" not in res.json()["error"]["message"]  # internals are not leaked to the browser


def test_malformed_provider_output_is_a_clean_502(client_a):
    class WrongCount(FakeIdentifier):  # one identification for two boxes
        def identify(self, image, regions, labels):
            return super().identify(image, regions[:1], labels)

    use_real(recognizer(FakeLocator(BOX, region(0.6, 0.1, 0.3, 0.3)), WrongCount({MAGGI: 0.9})))
    assert send_frame(client_a).status_code == 502


def test_unconfigured_real_provider_is_clean_503_never_mock(client_a):
    class Unavailable:
        def locate(self, image):
            raise IntegrationNotConfigured("Real vision needs the optional dependencies")

    use_real(recognizer(Unavailable(), FakeIdentifier()))
    res = send_frame(client_a)
    assert res.status_code == 503 and res.json()["error"]["code"] == "vision_unavailable"
    assert "optional dependencies" in res.json()["error"]["message"]


# ---- opt-in: the real models (OWL-ViT + CLIP + RapidOCR) ----

SMOKE = os.environ.get("VISION_REAL_SMOKE") == "1"
smoke = pytest.mark.skipif(not SMOKE, reason="set VISION_REAL_SMOKE=1 (and `uv sync --extra vision`) to run the real models")
NAMES = ("Butter Croissant 45g", "Glucose Biscuits 250g", "Instant Noodles 70g", "Antiseptic Liquid 125ml")


@smoke
def test_smoke_real_models_find_nothing_on_a_blank_frame():
    pytest.importorskip("torch")
    real = real_recognizer(RealVisionConfig()).for_catalog(NAMES)
    assert real.recognize(image_bytes("JPEG", (640, 480))) == []  # a flat colour contains no product


@smoke
def test_smoke_real_ocr_reads_printed_text():
    """The real OCR engine on a rendered label (no product photo needed)."""
    pytest.importorskip("rapidocr_onnxruntime")
    from PIL import ImageDraw, ImageFont

    from app.integrations.vision_real import RapidOcrReader
    from app.modules.vision.matching import ReadText

    image = Image.new("RGB", (640, 240), (250, 240, 200))
    font = ImageFont.load_default(size=64)
    ImageDraw.Draw(image).text((30, 70), "BUTTER CROISSANT", fill=(120, 20, 20), font=font)
    read = ReadText(" ".join(t.text for t in RapidOcrReader().read(image)), MatchingConfig().fuzzy)
    assert read.has("butter") and read.has("croissant") and not read.has("biscuits")


@pytest.mark.skipif(not SMOKE or not os.environ.get("VISION_REAL_SMOKE_DIR"), reason="needs VISION_REAL_SMOKE_DIR")
def test_smoke_real_detector_box_follows_the_packet_up_and_down_a_webcam_frame():
    """The real detector on 960x540 frames: a real pack photo placed in the upper, middle and
    lower part must be boxed where it was placed (the box stays on the photo and covers most of it)."""
    pytest.importorskip("torch")
    photos = sorted(p for p in Path(os.environ["VISION_REAL_SMOKE_DIR"]).iterdir() if p.suffix.lower() in {".jpg", ".png"})
    with Image.open(photos[0]) as img:
        photo = img.convert("RGB")
    photo.thumbnail((420, 230))
    real = real_recognizer(RealVisionConfig())
    for top in (20, 150, 540 - photo.height - 20):
        frame = Image.new("RGB", (960, 540), (128, 124, 118))
        frame.paste(photo, (270, top))
        data = BytesIO()
        frame.save(data, "JPEG", quality=90)
        regions = real.observe(data.getvalue()).regions
        assert regions, f"nothing detected with the packet at y={top}"
        left, box_top, right, bottom = crop_rect((960, 540), regions[0].box, pad=0)
        assert left >= 270 - 12 and right <= 270 + photo.width + 12, (top, left, right)
        assert box_top >= top - 12 and bottom <= top + photo.height + 12, (top, box_top, bottom)
        covered = (right - left) * (bottom - box_top) / (photo.width * photo.height)
        assert covered >= 0.5, (top, covered)


@pytest.mark.skipif(not SMOKE or not os.environ.get("VISION_REAL_SMOKE_DIR"), reason="needs VISION_REAL_SMOKE_DIR")
def test_smoke_real_photos_resolve_to_the_expected_catalog_product():
    """Real photos through the real models and the real matcher. VISION_REAL_SMOKE_DIR holds
    photos named '<expected catalog product name>.jpg' (or 'unknown*.jpg' for a product that is
    not in the catalog); the catalog is every expected name in the folder."""
    pytest.importorskip("torch")
    from app.modules.vision import matching

    photos = sorted(p for p in Path(os.environ["VISION_REAL_SMOKE_DIR"]).iterdir() if p.suffix.lower() in {".jpg", ".png"})
    names = sorted({p.stem.split("__")[0] for p in photos if not p.stem.lower().startswith("unknown")})
    real = real_recognizer(RealVisionConfig()).for_catalog(tuple(names))
    entries = [matching.Entry(n, n) for n in names]
    wrong = []
    for photo in photos:
        expected = None if photo.stem.lower().startswith("unknown") else photo.stem.split("__")[0]
        decisions = [matching.decide(i.evidence, entries, MatchingConfig()) for i in real.recognize(photo.read_bytes())]
        matched = {d.best.key for d in decisions if d.state == matching.MatchState.MATCHED}
        if matched - {expected}:  # a false catalog match is the failure that matters most
            wrong.append((photo.name, sorted(matched)))
        elif expected is not None and expected not in {s.key for d in decisions for s in d.ranked}:
            wrong.append((photo.name, "expected product was not even offered"))
    assert not wrong, wrong
