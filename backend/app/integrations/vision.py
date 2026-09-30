from typing import Protocol

from app.integrations.types import IntegrationNotConfigured, RecognizedItem


class ProductRecognizer(Protocol):
    """Camera frame -> recognized products (source=VISION)."""

    def recognize(self, image: bytes) -> list[RecognizedItem]: ...


class NotConfiguredRecognizer:
    def recognize(self, image: bytes) -> list[RecognizedItem]:
        raise IntegrationNotConfigured("No vision provider configured")
