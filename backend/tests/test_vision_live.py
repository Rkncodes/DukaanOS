"""Live Vision Counter: camera frames -> mock live provider -> catalog matching.
Recognition is read-only; confirmation still goes through billing.add_recognized_items -> add_item."""

import pytest

from app.core.enums import InputSource
from app.integrations.vision import (
    MockLiveRecognizer,
    NotConfiguredFrameRecognizer,
    build_frame_recognizer,
)
from app.main import app
from app.modules.billing import service as billing
from app.modules.vision.router import get_frame_recognizer
from tests.conftest import create_cart, create_product
from tests.test_vision import image_bytes, seed_demo_catalog

FRAMES = "/api/v1/vision/frames"


def send_frame(client, sequence: int | None = 0, data: bytes | None = None, content_type: str = "image/jpeg"):
    form = {} if sequence is None else {"sequence": str(sequence)}
    return client.post(
        FRAMES, files={"image": ("frame.jpg", image_bytes("JPEG") if data is None else data, content_type)}, data=form
    )


def labels(result: dict) -> list[str]:
    return [d["label"] for d in result["detections"]]


# ---- mock live provider ----


def test_mock_live_is_deterministic_by_sequence_and_ignores_the_frame():
    mock = build_frame_recognizer("mock")
    assert isinstance(mock, MockLiveRecognizer) and mock.is_mock and mock.name == "mock-live"
    assert mock.recognize_frame(image_bytes(), sequence=5) == mock.recognize_frame(b"anything", sequence=5)
    assert mock.recognize_frame(b"", sequence=1) == mock.recognize_frame(b"", sequence=1 + len(mock.SCENES))
    for sequence in range(len(mock.SCENES)):
        for item in mock.recognize_frame(b"", sequence=sequence):
            assert item.source == InputSource.VISION and item.name_hint and item.confidence is not None
            box = item.bbox
            assert box is not None
            assert 0 <= box.x and 0 <= box.y and box.x + box.width <= 1 and box.y + box.height <= 1
    assert isinstance(build_frame_recognizer("none"), NotConfiguredFrameRecognizer)


def test_products_appear_and_disappear_between_scans(client_a):
    seed_demo_catalog(client_a)
    app.dependency_overrides[get_frame_recognizer] = MockLiveRecognizer
    scenes = [send_frame(client_a, seq).json() for seq in range(4)]

    assert labels(scenes[0]) == ["Maggi 2-Minute Noodles"]  # one product
    assert labels(scenes[1]) == ["Maggi 2-Minute Noodles", "Coke 750ml"]  # several
    assert labels(scenes[2]) == ["Maggi 2-Minute Noodles", "Coke 750ml", "Cold drink 750ml", "Parle-G Biscuits"]
    assert "Maggi 2-Minute Noodles" not in labels(scenes[3])  # taken off the counter
    assert [s["sequence"] for s in scenes] == [0, 1, 2, 3]


# ---- result shape, boxes, matching ----


def test_frame_result_shape_boxes_names_and_prices(client_a):
    catalog = seed_demo_catalog(client_a)
    app.dependency_overrides[get_frame_recognizer] = MockLiveRecognizer
    res = send_frame(client_a, 2)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["provider"] == "mock-live" and body["is_mock"] is True and body["sequence"] == 2

    by_label = {d["label"]: d for d in body["detections"]}
    maggi = by_label["Maggi 2-Minute Noodles"]
    assert maggi["match"] == "matched" and maggi["quantity"] == "2.000" and maggi["confidence"] == 0.94
    assert maggi["product"]["id"] == catalog["Maggi 2-Minute Noodles 70g"]["id"]
    assert maggi["product"]["price"] == "14.00"
    assert maggi["bbox"] == {"x": 0.06, "y": 0.3, "width": 0.22, "height": 0.3}
    assert by_label["Coke 750ml"]["product"]["price"] == "40.00"
    assert by_label["Cold drink 750ml"]["match"] == "ambiguous"
    assert len(by_label["Cold drink 750ml"]["candidates"]) == 3
    assert by_label["Parle-G Biscuits"]["match"] == "low_confidence"
    assert all(d["bbox"] is not None for d in body["detections"])


def test_unmatched_live_item_is_never_matched(client_a):
    seed_demo_catalog(client_a)  # no Dairy Milk in this test catalog
    app.dependency_overrides[get_frame_recognizer] = MockLiveRecognizer
    by_label = {d["label"]: d for d in send_frame(client_a, 3).json()["detections"]}
    assert by_label["Red toothpaste tube"]["match"] == "unmatched"
    assert by_label["Red toothpaste tube"]["product"] is None
    assert by_label["Dairy Milk Chocolate"]["product"] is None


# ---- validation / configuration ----


@pytest.mark.parametrize(
    ("sequence", "data", "content_type", "status"),
    [
        (-1, None, "image/jpeg", 422),
        (0, b"not an image", "image/jpeg", 422),
        (0, None, "text/plain", 422),
        (None, None, "image/jpeg", 200),  # sequence defaults to 0
    ],
)
def test_frame_validation(client_a, sequence, data, content_type, status):
    app.dependency_overrides[get_frame_recognizer] = MockLiveRecognizer
    assert send_frame(client_a, sequence, data, content_type).status_code == status


def test_frames_require_login_and_a_configured_provider(client_a, make_client):
    assert send_frame(make_client()).status_code == 401
    app.dependency_overrides[get_frame_recognizer] = NotConfiguredFrameRecognizer
    res = send_frame(client_a)
    assert res.status_code == 503 and res.json()["error"]["code"] == "vision_unavailable"


# ---- merchant isolation ----


def test_live_matching_only_sees_own_catalog(client_a, client_b):
    a = seed_demo_catalog(client_a)
    b_coke = create_product(client_b, name="Coke 750ml")
    app.dependency_overrides[get_frame_recognizer] = MockLiveRecognizer

    a_ids = {p["id"] for p in a.values()}
    for detection in send_frame(client_b, 2).json()["detections"]:
        offered = [detection["product"]] if detection["product"] else detection["candidates"]
        assert all(p["id"] not in a_ids for p in offered)  # never another merchant's product
    b_by_label = {d["label"]: d for d in send_frame(client_b, 2).json()["detections"]}
    assert b_by_label["Coke 750ml"]["product"]["id"] == b_coke["id"]
    assert b_by_label["Maggi 2-Minute Noodles"]["match"] == "unmatched"


# ---- no cart mutation; confirmation uses the existing billing path ----


def test_live_scanning_never_touches_the_cart(client_a):
    seed_demo_catalog(client_a)
    cart = create_cart(client_a)
    app.dependency_overrides[get_frame_recognizer] = MockLiveRecognizer
    for seq in range(8):
        assert send_frame(client_a, seq).status_code == 200
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["items"] == []


def test_confirming_live_detections_goes_through_add_item(client_a, monkeypatch):
    seed_demo_catalog(client_a)
    app.dependency_overrides[get_frame_recognizer] = MockLiveRecognizer
    detections = send_frame(client_a, 1).json()["detections"]  # Maggi x2 + Coke, both matched

    calls = []
    original = billing.add_item

    def spy(*args, **kwargs):
        calls.append(args[3:])  # (product_id, quantity, source)
        return original(*args, **kwargs)

    monkeypatch.setattr(billing, "add_item", spy)
    cart = create_cart(client_a)
    items = [{"product_id": d["product"]["id"], "quantity": d["quantity"]} for d in detections]
    res = client_a.post(f"/api/v1/carts/{cart['id']}/recognized-items", json={"source": "vision", "items": items})
    assert res.status_code == 200, res.text
    assert len(calls) == 2 and all(c[2] == InputSource.VISION for c in calls)
    assert res.json()["subtotal"] == "68.00"  # 2 x 14 + 40

    order = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"}).json()
    assert order["total"] == "68.00" and order["payment_status"] == "paid"
