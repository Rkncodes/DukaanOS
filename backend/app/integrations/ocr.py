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
    # The piece as it was written, when the reader reports its four corners: the direction of
    # its baseline (radians; 0 = level) and its size along and across that baseline. Zero size
    # means "not reported": the upright box above is used instead.
    angle: float = 0.0
    width: float = 0.0
    height: float = 0.0


# A gap this many character-widths wide between two neighbouring characters was written as a gap
# ("4   5 Star": the quantity stands apart). The reader places characters only roughly, and across
# the test photos gaps *inside* a word measure up to 1.45 widths, so anything narrower than this
# proves nothing and is left alone: a normal word space is about 1 width and is not put back here.
WORD_GAP = 2.0


def respace(text: str, characters: Any, boxes: Any, direction: tuple[float, float]) -> str:
    """`text` with a space put back wherever the reader dropped a wide written gap.

    `characters` and `boxes` are the reader's own account of the piece: each character and the
    four corners of where it sits; `direction` is the piece's baseline (unit vector). Only spaces
    are ever added. If that account is missing, malformed or does not spell `text`, the text is
    returned as it was read."""
    try:
        if len(characters) != len(boxes) or len(characters) < 2 or "".join(characters) != text:
            return text
        if any(not isinstance(c, str) or len(c) != 1 for c in characters):
            return text
        spans = []
        for box in boxes:
            along = [float(p[0]) * direction[0] + float(p[1]) * direction[1] for p in box]
            if len(along) != 4 or not all(math.isfinite(v) for v in along):
                return text
            spans.append((min(along), max(along)))
    except (TypeError, ValueError, IndexError):
        return text
    widths = sorted(end - start for c, (start, end) in zip(characters, spans, strict=True) if not c.isspace())
    if len(widths) < 2 or widths[len(widths) // 2] <= 0:
        return text
    wide = WORD_GAP * widths[len(widths) // 2]  # the middle width: one odd character does not move it
    out = [characters[0]]
    for i in range(1, len(characters)):
        if not characters[i - 1].isspace() and not characters[i].isspace() and spans[i][0] - spans[i - 1][1] >= wide:
            out.append(" ")
        out.append(characters[i])
    return "".join(out)


def parse_ocr_result(result: Any) -> list[Word]:
    """RapidOCR returns [[4 corner points], text, score] per piece (or None), followed, when asked
    for, by where each character sits: [character boxes], [characters], [their scores].
    Malformed entries are skipped."""
    found = []
    for entry in result or []:
        try:
            points, text, score = entry[:3]
            xs = [float(p[0]) for p in points]
            ys = [float(p[1]) for p in points]
            score = float(score)
        except (TypeError, ValueError, IndexError):
            continue
        if not isinstance(text, str) or not text.strip() or not math.isfinite(score):
            continue
        if not all(math.isfinite(v) for v in xs + ys) or max(ys) <= min(ys):
            continue
        angle = width = height = 0.0
        if len(xs) == 4:  # top-left, top-right, bottom-right, bottom-left
            angle = math.atan2(ys[1] - ys[0], xs[1] - xs[0])
            width = math.hypot(xs[1] - xs[0], ys[1] - ys[0])
            height = math.hypot(xs[3] - xs[0], ys[3] - ys[0])
        if width > 0 and len(entry) >= 5:
            text = respace(text, entry[4], entry[3], ((xs[1] - xs[0]) / width, (ys[1] - ys[0]) / width))
        found.append(Word(text.strip(), min(xs), min(ys), max(xs), max(ys), score, angle, width, height))
    return found


SAME_LINE = 0.6  # two pieces are one written line when they share this much of the smaller one's height
MAX_HEIGHT_RATIO = 2.5  # ...and neither is this much taller than the other (a box spanning several lines)
MAX_TILT = math.radians(30)  # a steeper "tilt" is a misread box, not a tilted photo


def _size(word: Word) -> tuple[float, float]:
    """(width, height) along and across the writing direction."""
    if word.width > 0 and word.height > 0:
        return word.width, word.height
    return word.right - word.left, word.bottom - word.top


def page_tilt(found: list[Word]) -> float:
    """How far the writing slopes on the photo (radians): the middle baseline direction of the
    pieces long enough to have one, longer pieces counting for more. A lone digit's box says
    nothing about direction, so short pieces are left out. 0 when nothing tells."""
    sloped = sorted(
        (w.angle, _size(w)[0]) for w in found if _size(w)[0] >= 2 * _size(w)[1] and abs(w.angle) <= MAX_TILT
    )
    half = sum(width for _, width in sloped) / 2
    for angle, width in sloped:
        half -= width
        if half <= 0:
            return angle
    return 0.0


def rows(found: list[Word], *, min_score: float = 0.5) -> list[ParchiText]:
    """Group pieces into written lines, left to right ("2" and "Maggi" read separately are one line).

    A parchi is rarely photographed level, and a quantity written apart from its item then sits
    higher or lower on the photo than the item does. So positions are first levelled by the
    page's tilt; two pieces are then one line when they overlap vertically by most of the smaller
    one's height. A piece is only ever compared with the line just above it: one that fits no
    line stays a line of its own and is never attached to a neighbouring item."""
    kept = [w for w in found if w.score >= min_score]
    tilt = page_tilt(kept)
    cos, sin = math.cos(tilt), math.sin(tilt)

    def level(word: Word) -> tuple[float, float, float]:
        """(left-to-right position, top, bottom) on the levelled page."""
        x, y = (word.left + word.right) / 2, (word.top + word.bottom) / 2
        height = _size(word)[1]
        centre = y * cos - x * sin
        return x * cos + y * sin, centre - height / 2, centre + height / 2

    placed = sorted(((word, *level(word)) for word in kept), key=lambda p: (p[2] + p[3]) / 2)
    lines: list[list[tuple[Word, float, float, float]]] = []
    for piece in placed:
        _, _, top, bottom = piece
        if lines:
            # The line's place on the page is that of its longest piece: the item's name, not a
            # stray mark, decides where the line is, and a line cannot drift as pieces join it.
            _, _, line_top, line_bottom = max(lines[-1], key=lambda p: _size(p[0])[0])
            smaller = min(bottom - top, line_bottom - line_top)
            larger = max(bottom - top, line_bottom - line_top)
            shared = min(bottom, line_bottom) - max(top, line_top)
            if smaller > 0 and shared >= SAME_LINE * smaller and larger <= MAX_HEIGHT_RATIO * smaller:
                lines[-1].append(piece)
                continue
        lines.append([piece])
    return [
        ParchiText(" ".join(p[0].text for p in sorted(line, key=lambda p: p[1])), min(p[0].score for p in line))
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

            # BGR. The characters' positions show the gaps the reader leaves out of its text (respace).
            result, _ = engine(np.asarray(photo)[:, :, ::-1], return_word_box=True)
        return rows(parse_ocr_result(result))


_local = RapidOcrParchiReader()


def build_parchi_reader(provider: str) -> ParchiReader:
    """Provider registry. There is no mock and no fallback: anything but "ocr" is switched off."""
    return _local if provider == "ocr" else NotConfiguredParchiReader()
