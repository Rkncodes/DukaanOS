from typing import TYPE_CHECKING, Protocol, runtime_checkable

from app.integrations.types import IntegrationNotConfigured, RecognizedItem

if TYPE_CHECKING:
    from app.integrations.vision_real import RealLiveRecognizer, RealVisionConfig


class ProductRecognizer(Protocol):
    """Photo -> recognized products (source=VISION), determined by the image's pixels.

    Providers only describe what they see (evidence, or name_hint / barcode, and a bbox).
    Mapping to the merchant's catalog happens in app.modules.vision, never here.
    """

    name: str
    is_mock: bool

    def recognize(self, image: bytes) -> list[RecognizedItem]: ...


class FrameRecognizer(Protocol):
    """Live camera frame -> recognized products (source=VISION), determined by the image.

    `sequence` is the client's frame counter (monotonic per camera session), used for
    ordering/staleness; it must never decide *what* is recognized. Same contract as
    ProductRecognizer: describe what is seen; catalog matching happens in app.modules.vision.
    """

    name: str
    is_mock: bool

    def recognize_frame(self, image: bytes, *, sequence: int) -> list[RecognizedItem]: ...


@runtime_checkable
class CatalogAwareRecognizer(Protocol):
    """Optional capability: a provider that scores what it sees against the merchant's catalog.
    The vision service passes the logged-in merchant's active product *names* (never prices or
    ids) per request; the provider returns observations (`RecognizedItem.evidence`), not decisions."""

    def for_catalog(self, labels: tuple[str, ...]) -> "RealLiveRecognizer": ...


@runtime_checkable
class ReferenceEmbedder(Protocol):
    """Optional capability: turn a merchant's photo of a product's packaging into an appearance
    embedding comparable with `Evidence.embedding` (same `embedding_model`)."""

    def embed_reference(self, image: bytes) -> tuple[str, tuple[float, ...]]: ...


class NotConfiguredRecognizer:
    """VISION_PROVIDER=none: recognition is switched off (503), never faked."""

    name = "none"
    is_mock = False

    def recognize(self, image: bytes) -> list[RecognizedItem]:
        raise IntegrationNotConfigured("Vision is switched off (VISION_PROVIDER=none)")

    def recognize_frame(self, image: bytes, *, sequence: int) -> list[RecognizedItem]:
        raise IntegrationNotConfigured("Vision is switched off (VISION_PROVIDER=none)")


def build_recognizer(provider: str, real: "RealVisionConfig | None" = None) -> ProductRecognizer:
    """Provider registry. Callers depend only on the protocols; there is no mock and no fallback."""
    return _real(real) if provider == "real" else NotConfiguredRecognizer()


def build_frame_recognizer(provider: str, real: "RealVisionConfig | None" = None) -> FrameRecognizer:
    return _real(real) if provider == "real" else NotConfiguredRecognizer()


def _real(config: "RealVisionConfig | None") -> "RealLiveRecognizer":
    # Imported lazily: the module itself is light, torch/transformers load on the first frame.
    from app.integrations.vision_real import RealVisionConfig, real_recognizer

    return real_recognizer(config or RealVisionConfig())
