from typing import Protocol

from app.integrations.types import IntegrationNotConfigured


class SpeechToText(Protocol):
    def transcribe(self, audio: bytes, *, language: str | None = None) -> str: ...


class TextToSpeech(Protocol):
    def synthesize(self, text: str, *, language: str | None = None) -> bytes: ...


class NotConfiguredSpeechToText:
    def transcribe(self, audio: bytes, *, language: str | None = None) -> str:
        raise IntegrationNotConfigured("No speech-to-text provider configured")


class NotConfiguredTextToSpeech:
    def synthesize(self, text: str, *, language: str | None = None) -> bytes:
        raise IntegrationNotConfigured("No text-to-speech provider configured")
