from typing import Protocol

from app.integrations.types import IntegrationNotConfigured, RecognizedItem


class ParchiReader(Protocol):
    """Photo of a handwritten list/parchi -> line items (source=PARCHI)."""

    def read(self, image: bytes) -> list[RecognizedItem]: ...


class NotConfiguredParchiReader:
    def read(self, image: bytes) -> list[RecognizedItem]:
        raise IntegrationNotConfigured("No OCR provider configured")
