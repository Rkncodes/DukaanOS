"""Vision -> Bill (photo): upload validation, merchant-scoped catalog matching, and confirmed
items entering the existing cart (then the existing checkout). The provider is replaced at its
boundary by FakeRecognizer; the real image-based provider is covered in test_vision_real.py."""

import uuid
from decimal import Decimal
from io import BytesIO

import pytest
from PIL import Image
from pydantic import ValidationError

from app.core.enums import InputSource
from app.integrations.types import BoundingBox, RecognizedItem
from app.integrations.vision import NotConfiguredRecognizer, build_recognizer
from app.main import app
from app.modules.vision.image import MAX_IMAGE_BYTES
from app.modules.vision.router import get_recognizer
from app.modules.vision.schemas import Detection
from tests.conftest import create_cart, create_product

RECOGNIZE = "/api/v1/vision/recognize"


def image_bytes(fmt: str = "PNG", size: tuple[int, int] = (64, 48)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buf, format=fmt)
    return buf.getvalue()


def upload(client, data: bytes | None = None, content_type: str = "image/png", name: str = "shelf.png"):
    data = image_bytes() if data is None else data
    return client.post(RECOGNIZE, files={"image": (name, data, content_type)})


class FakeRecognizer:
    """Test double: returns exactly the items it was given."""

    name = "fake"
    is_mock = True

    def __init__(self, *items: RecognizedItem):
        self.items = list(items)

    def recognize(self, image: bytes) -> list[RecognizedItem]:
        return self.items


def use_recognizer(recognizer) -> None:
    app.dependency_overrides[get_recognizer] = lambda: recognizer  # cleared by make_client


def seen(name: str | None = None, *, confidence: float | None = 0.9, **kw) -> RecognizedItem:
    return RecognizedItem(source=InputSource.VISION, name_hint=name, confidence=confidence, **kw)


def seed_demo_catalog(client) -> dict[str, dict]:
    names = {
        "Maggi 2-Minute Noodles 70g": "14.00",
        "Coke 750ml": "40.00",
        "Pepsi 750ml": "40.00",
        "Thums Up 750ml": "40.00",
        "Parle-G Biscuits 250g": "25.00",
        "Colgate Strong Teeth 200g": "110.00",
    }
    return {n: create_product(client, name=n, price=p, stock_quantity="50") for n, p in names.items()}


# ---- request validation ----


def test_accepts_png_jpeg_webp(client_a):
    use_recognizer(FakeRecognizer())
    for fmt, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
        res = upload(client_a, image_bytes(fmt), mime)
        assert res.status_code == 200, (fmt, res.text)
        assert res.json()["detections"] == []


@pytest.mark.parametrize(
    ("data", "content_type", "code"),
    [
        (b"", "image/png", "invalid_image"),
        (b"just some text", "text/plain", "invalid_image"),
        (b"not an image at all", "image/png", "invalid_image"),
        (image_bytes()[:40], "image/png", "invalid_image"),  # truncated: header parses, pixels don't
        (image_bytes("GIF"), "image/png", "invalid_image"),  # lies about its type
        (image_bytes(), "application/octet-stream", "invalid_image"),
    ],
)
def test_rejects_invalid_uploads(client_a, data, content_type, code):
    use_recognizer(FakeRecognizer())
    res = upload(client_a, data, content_type)
    assert res.status_code == 422, res.text
    assert res.json()["error"]["code"] == code


def test_rejects_oversized_upload(client_a):
    res = upload(client_a, b"\x89PNG" + b"0" * MAX_IMAGE_BYTES)
    assert res.status_code == 413
    assert res.json()["error"]["code"] == "image_too_large"


def test_requires_image_field_and_login(client_a, make_client):
    assert client_a.post(RECOGNIZE).status_code == 422
    assert upload(make_client()).status_code == 401


def test_unconfigured_provider_is_503(client_a):
    use_recognizer(NotConfiguredRecognizer())
    res = upload(client_a)
    assert res.status_code == 503 and res.json()["error"]["code"] == "vision_unavailable"


# ---- recognized item / result schema ----


def test_recognized_item_defaults_and_bbox():
    item = RecognizedItem(source=InputSource.VISION, name_hint="Coke")
    assert item.quantity == 1 and item.confidence is None and item.bbox is None
    boxed = seen("Coke", bbox=BoundingBox(0.1, 0.2, 0.3, 0.4))
    assert boxed.bbox == BoundingBox(x=0.1, y=0.2, width=0.3, height=0.4)


def test_detection_rejects_out_of_range_confidence():
    base = dict(id="d0", label="x", barcode=None, quantity=Decimal(1), bbox=None, match="unmatched",
                product=None, candidates=[])  # fmt: skip
    Detection(**base, confidence=1.0)
    with pytest.raises(ValidationError):
        Detection(**base, confidence=1.5)


def test_result_shape(client_a):
    create_product(client_a, name="Coke 750ml")
    use_recognizer(FakeRecognizer(seen("Coke 750ml", quantity=Decimal(3), bbox=BoundingBox(0.1, 0.2, 0.3, 0.4))))
    body = upload(client_a).json()
    assert body["provider"] == "fake" and body["is_mock"] is True
    [d] = body["detections"]
    assert d["id"] == "d0" and d["label"] == "Coke 750ml" and d["quantity"] == "3.000"
    assert d["confidence"] == 0.9
    assert d["bbox"] == {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4}


# ---- provider registry ----


def test_registry_has_no_mock_provider():
    assert isinstance(build_recognizer("none"), NotConfiguredRecognizer)
    assert isinstance(build_recognizer("mock"), NotConfiguredRecognizer)  # unknown names never fall back to fakes


# ---- matching ----


def test_ambiguous_when_several_products_fully_match(client_a):
    create_product(client_a, name="Maggi Noodles Masala")
    create_product(client_a, name="Maggi Noodles Atta")
    use_recognizer(FakeRecognizer(seen("maggi noodles")))
    [d] = upload(client_a).json()["detections"]
    assert d["match"] == "ambiguous" and d["product"] is None
    assert len(d["candidates"]) == 2  # shown, never silently chosen


def test_single_full_match_beats_partial_matches(client_a):
    create_product(client_a, name="Coke 750ml")
    create_product(client_a, name="Coke 2 L")
    use_recognizer(FakeRecognizer(seen("coke 750 ml bottle")))  # unit spacing + packaging word
    [d] = upload(client_a).json()["detections"]
    assert d["match"] == "matched" and d["product"]["name"] == "Coke 750ml"


def test_unmatched_and_inactive_products_are_never_offered(client_a):
    retired = create_product(client_a, name="Old Soap")
    client_a.delete(f"/api/v1/products/{retired['id']}")
    use_recognizer(FakeRecognizer(seen("Old Soap"), seen("Mystery item"), seen(None)))
    detections = upload(client_a).json()["detections"]
    assert [d["match"] for d in detections] == ["unmatched"] * 3
    assert all(d["candidates"] == [] for d in detections)


@pytest.mark.parametrize(("confidence", "state"), [(0.6, "matched"), (0.59, "low_confidence"), (None, "matched")])
def test_confidence_threshold(client_a, confidence, state):
    create_product(client_a, name="Tata Salt 1kg")
    use_recognizer(FakeRecognizer(seen("Tata Salt", confidence=confidence)))
    assert upload(client_a).json()["detections"][0]["match"] == state


def test_barcode_and_product_id_detections(client_a):
    salt = create_product(client_a, name="Tata Salt 1kg", barcode="8900000000128")
    use_recognizer(
        FakeRecognizer(
            seen(barcode="8900000000128"),
            seen(product_id=uuid.UUID(salt["id"])),
            seen(barcode="0000"),
        )
    )
    states = [(d["match"], d["product"] and d["product"]["id"]) for d in upload(client_a).json()["detections"]]
    assert states == [("matched", salt["id"]), ("matched", salt["id"]), ("unmatched", None)]


def test_recognize_does_not_touch_any_cart(client_a):
    seed_demo_catalog(client_a)
    cart = create_cart(client_a)
    use_recognizer(FakeRecognizer(seen("Maggi 2-Minute Noodles 70g"), seen("Mystery item")))
    assert upload(client_a).json()["detections"][0]["match"] == "matched"
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["items"] == []


# ---- merchant isolation ----


def test_matching_only_sees_own_catalog(client_a, client_b):
    a_coke = create_product(client_a, name="Coke 750ml")
    b_pepsi = create_product(client_b, name="Pepsi 750ml")
    use_recognizer(
        FakeRecognizer(
            seen("Coke 750ml"),
            seen("750ml"),
            seen(product_id=uuid.UUID(b_pepsi["id"])),  # another merchant's product id
        )
    )
    detections = upload(client_a).json()["detections"]
    assert detections[0]["product"]["id"] == a_coke["id"]
    assert detections[1]["match"] == "matched" and detections[1]["product"]["id"] == a_coke["id"]
    assert detections[2]["match"] == "unmatched"

    # Store B sees only its own product for the same photo.
    b_detections = upload(client_b).json()["detections"]
    # B has no Coke: its own Pepsi is offered as a partial candidate, never auto-chosen, never A's Coke.
    assert b_detections[0]["match"] == "ambiguous" and b_detections[0]["product"] is None
    assert [c["id"] for c in b_detections[0]["candidates"]] == [b_pepsi["id"]]
    assert b_detections[1]["product"]["id"] == b_pepsi["id"]
    assert b_detections[2]["product"]["id"] == b_pepsi["id"]  # B's own id resolves for B


def test_cannot_confirm_another_merchants_product(client_a, client_b):
    mine = create_product(client_a, name="Mine")
    theirs = create_product(client_b, name="Theirs")
    cart = create_cart(client_a)
    res = client_a.post(
        f"/api/v1/carts/{cart['id']}/recognized-items",
        json={"items": [{"product_id": mine["id"]}, {"product_id": theirs["id"]}]},
    )
    assert res.status_code == 404
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["items"] == []  # all or nothing

    b_cart = create_cart(client_b)
    res = client_a.post(f"/api/v1/carts/{b_cart['id']}/recognized-items", json={"items": [{"product_id": mine["id"]}]})
    assert res.status_code == 404


# ---- confirmed items -> existing cart -> existing checkout ----


def test_confirmed_items_join_existing_cart_and_checkout(client_a):
    catalog = seed_demo_catalog(client_a)
    maggi, coke = catalog["Maggi 2-Minute Noodles 70g"], catalog["Coke 750ml"]
    cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": maggi["id"]})  # manual first

    res = client_a.post(
        f"/api/v1/carts/{cart['id']}/recognized-items",
        json={"items": [{"product_id": maggi["id"], "quantity": "2"}, {"product_id": coke["id"]}]},
    )
    assert res.status_code == 200, res.text
    lines = {i["product_name"]: i for i in res.json()["items"]}
    assert lines["Maggi 2-Minute Noodles 70g"]["quantity"] == "3.000"  # merged into the same line
    assert lines["Coke 750ml"]["source"] == "vision"
    assert res.json()["subtotal"] == "82.00"

    order = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).json()
    assert order["payment_status"] == "paid" and order["total"] == "82.00"
    assert {i["product_name"]: i["source"] for i in order["items"]}["Coke 750ml"] == "vision"
    assert client_a.get(f"/api/v1/products/{coke['id']}").json()["stock_quantity"] == "49.000"


def test_confirmed_items_validation(client_a):
    product = create_product(client_a)
    cart = create_cart(client_a)
    url = f"/api/v1/carts/{cart['id']}/recognized-items"
    assert client_a.post(url, json={"items": []}).status_code == 422
    assert client_a.post(url, json={"items": [{"product_id": product["id"], "quantity": "0"}]}).status_code == 422
    assert client_a.post(url, json={"items": [{"name_hint": "Maggi"}]}).status_code == 422  # ids only

    client_a.post(url, json={"items": [{"product_id": product["id"]}]})
    client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})
    assert client_a.post(url, json={"items": [{"product_id": product["id"]}]}).status_code == 409  # closed cart
