from decimal import Decimal
from typing import Protocol

from app.core.enums import InputSource
from app.integrations.types import BoundingBox, IntegrationNotConfigured, RecognizedItem


class ProductRecognizer(Protocol):
    """Camera frame -> recognized products (source=VISION).

    Providers only describe what they see (name_hint / barcode, confidence, bbox).
    Mapping to the merchant's catalog happens in app.modules.vision, never here.
    """

    name: str
    is_mock: bool

    def recognize(self, image: bytes) -> list[RecognizedItem]: ...


class NotConfiguredRecognizer:
    name = "none"
    is_mock = False

    def recognize(self, image: bytes) -> list[RecognizedItem]:
        raise IntegrationNotConfigured("No vision provider configured")


def _seen(name: str, quantity: int, confidence: float, bbox: tuple[float, float, float, float]) -> RecognizedItem:
    return RecognizedItem(
        source=InputSource.VISION,
        name_hint=name,
        quantity=Decimal(quantity),
        confidence=confidence,
        bbox=BoundingBox(*bbox),
    )


class MockRecognizer:
    """Development/test stand-in. NOT real recognition: it ignores the image content and
    returns the same fixed detections for every valid image, chosen to exercise each
    matching outcome against the demo catalog (app.seed):

      clear match, clear match, ambiguous (three 750ml drinks), low confidence, no match.
    """

    name = "mock"
    is_mock = True

    def recognize(self, image: bytes) -> list[RecognizedItem]:
        return [
            _seen("Maggi 2-Minute Noodles", 2, 0.94, (0.05, 0.10, 0.25, 0.35)),
            _seen("Coke 750ml", 1, 0.91, (0.35, 0.05, 0.15, 0.55)),
            _seen("Cold drink 750ml", 1, 0.72, (0.55, 0.08, 0.14, 0.50)),
            _seen("Parle-G Biscuits", 1, 0.41, (0.72, 0.40, 0.22, 0.20)),
            _seen("Red toothpaste tube", 1, 0.66, (0.10, 0.65, 0.40, 0.15)),
        ]


def build_recognizer(provider: str) -> ProductRecognizer:
    """Provider registry. A real vendor plugs in here; callers depend only on ProductRecognizer."""
    if provider == "mock":
        return MockRecognizer()
    return NotConfiguredRecognizer()


# ---- live camera frames ----


class FrameRecognizer(Protocol):
    """Live camera frame -> recognized products (source=VISION).

    `sequence` is the client's frame counter (monotonic per camera session). Real providers
    may use it for tracking/ordering or ignore it. Same contract as ProductRecognizer:
    describe what is seen; catalog matching happens in app.modules.vision.
    """

    name: str
    is_mock: bool

    def recognize_frame(self, image: bytes, *, sequence: int) -> list[RecognizedItem]: ...


class NotConfiguredFrameRecognizer:
    name = "none"
    is_mock = False

    def recognize_frame(self, image: bytes, *, sequence: int) -> list[RecognizedItem]:
        raise IntegrationNotConfigured("No live vision provider configured")


# Fixed positions so a product's box stays put while it is "on the counter".
_MAGGI = ("Maggi 2-Minute Noodles", 0.94, (0.06, 0.30, 0.22, 0.30))
_COKE = ("Coke 750ml", 0.91, (0.34, 0.12, 0.12, 0.55))
_DRINK = ("Cold drink 750ml", 0.72, (0.50, 0.14, 0.11, 0.52))
_PARLE = ("Parle-G Biscuits", 0.41, (0.66, 0.55, 0.26, 0.18))
_DAIRY = ("Dairy Milk Chocolate", 0.88, (0.66, 0.25, 0.20, 0.14))
_UNKNOWN = ("Red toothpaste tube", 0.66, (0.08, 0.72, 0.36, 0.12))


def _scene(*items: tuple[tuple[str, float, tuple[float, float, float, float]], int]) -> list[RecognizedItem]:
    return [_seen(name, qty, conf, bbox) for (name, conf, bbox), qty in items]


class MockLiveRecognizer:
    """Development/test stand-in for a live camera model. NOT real recognition: it ignores
    the frame and cycles through fixed "scenes" by `sequence`, so products appear and
    disappear between scans deterministically (names match the demo catalog in app.seed):

      0: Maggi alone                          (one product)
      1: Maggi x2 + Coke                      (several products)
      2: Maggi x2 + Coke + cold drink + Parle-G   (whole counter: ambiguous + low confidence)
      3: Coke + Dairy Milk + unknown item     (Maggi taken away, an unmatched item)
    """

    name = "mock-live"
    is_mock = True

    SCENES: tuple[tuple[tuple[tuple[str, float, tuple[float, float, float, float]], int], ...], ...] = (
        ((_MAGGI, 1),),
        ((_MAGGI, 2), (_COKE, 1)),
        ((_MAGGI, 2), (_COKE, 1), (_DRINK, 1), (_PARLE, 1)),
        ((_COKE, 1), (_DAIRY, 1), (_UNKNOWN, 1)),
    )

    def recognize_frame(self, image: bytes, *, sequence: int) -> list[RecognizedItem]:
        return _scene(*self.SCENES[sequence % len(self.SCENES)])


def build_frame_recognizer(provider: str) -> FrameRecognizer:
    if provider == "mock":
        return MockLiveRecognizer()
    return NotConfiguredFrameRecognizer()
