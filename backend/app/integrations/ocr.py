"""Parchi (handwritten or printed order list) -> lines of text.

A reader only reads: one `ParchiText` per written line, top to bottom. Which words are a
quantity and which catalogue product a line means is decided in app.modules.parchi, never here.
"""

import math
import threading
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Protocol

from PIL import Image

from app.integrations.types import IntegrationNotConfigured

INSTALL_HINT = "Reading a parchi needs the OCR engine: cd backend && uv sync --extra parchi"


@dataclass(frozen=True)
class ParchiText:
    """One written line as read from the photo."""

    text: str
    confidence: float | None = None  # 0..1 as reported by the reader, if it reports one


class ParchiReader(Protocol):
    """Photo of a parchi -> its lines of text, in reading order."""

    name: str

    def read(self, image: bytes) -> list[ParchiText]: ...


class NotConfiguredParchiReader:
    """PARCHI_PROVIDER=none: reading is switched off (503), never faked."""

    name = "none"

    def read(self, image: bytes) -> list[ParchiText]:
        raise IntegrationNotConfigured("Parchi reading is switched off (PARCHI_PROVIDER=none)")


@dataclass(frozen=True)
class Word:
    """A piece of text and where it sits in the image (pixels)."""

    text: str
    left: float
    top: float
    right: float
    bottom: float
    score: float


def parse_ocr_result(result: Any) -> list[Word]:
    """RapidOCR returns [[4 corner points], text, score] per piece (or None). Malformed entries are skipped."""
    found = []
    for entry in result or []:
        try:
            points, text, score = entry
            xs = [float(p[0]) for p in points]
            ys = [float(p[1]) for p in points]
            score = float(score)
        except (TypeError, ValueError, IndexError):
            continue
        if not isinstance(text, str) or not text.strip() or not math.isfinite(score):
            continue
        if not all(math.isfinite(v) for v in xs + ys) or max(ys) <= min(ys):
            continue
        found.append(Word(text.strip(), min(xs), min(ys), max(xs), max(ys), score))
    return found


def rows(found: list[Word], *, min_score: float = 0.5) -> list[ParchiText]:
    """Group pieces into written lines: pieces whose vertical centres fall within the same line
    height belong together ("2" and "Maggi" read separately are one line), left to right."""
    lines: list[list[Word]] = []
    for word in sorted((w for w in found if w.score >= min_score), key=lambda w: (w.top + w.bottom) / 2):
        centre = (word.top + word.bottom) / 2
        last = lines[-1] if lines else None
        if last is not None:
            top = min(w.top for w in last)
            bottom = max(w.bottom for w in last)
            if top + (bottom - top) * 0.25 <= centre <= bottom - (bottom - top) * 0.25:
                last.append(word)
                continue
        lines.append([word])
    return [
        ParchiText(" ".join(w.text for w in sorted(line, key=lambda w: w.left)), min(w.score for w in line))
        for line in lines
    ]


class RapidOcrParchiReader:
    """Local OCR (RapidOCR: PaddleOCR models on ONNX Runtime, CPU). No cloud, no API key: the
    photo never leaves this machine. Loaded on first use."""

    name = "local-ocr (rapidocr)"

    def __init__(self, max_side: int = 1600):
        self.max_side = max_side
        self._lock = threading.Lock()
        self._engine: Any = None

    def _get(self):
        if self._engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR
            except ImportError as exc:
                raise IntegrationNotConfigured(INSTALL_HINT) from exc
            self._engine = RapidOCR()
        return self._engine

    def read(self, image: bytes) -> list[ParchiText]:
        with Image.open(BytesIO(image)) as img:
            photo = img.convert("RGB")
        photo.thumbnail((self.max_side, self.max_side))  # phone photos are far larger than the text needs
        with self._lock:
            engine = self._get()
            import numpy as np

            result, _ = engine(np.asarray(photo)[:, :, ::-1])  # BGR
        return rows(parse_ocr_result(result))


_local = RapidOcrParchiReader()


def build_parchi_reader(provider: str) -> ParchiReader:
    """Provider registry. There is no mock and no fallback: anything but "ocr" is switched off."""
    return _local if provider == "ocr" else NotConfiguredParchiReader()
