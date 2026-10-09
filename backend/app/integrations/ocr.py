"""Parchi (handwritten or printed order list) -> lines of text.

A reader only reads: one `ParchiText` per written line, top to bottom. Which words are a
quantity and which catalogue product a line means is decided in app.modules.parchi, never here.
"""

import math
import re
import threading
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Protocol

from PIL import Image, ImageOps

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
    lines = [sorted(line, key=lambda p: p[1]) for line in lines]
    prices = _price_column(lines)
    read = []
    for line in lines:
        shown = [p for p in line if id(p) not in prices]
        if not shown:
            continue
        height = _line_height(line)
        text = shown[0][0].text
        for before, piece in zip(shown, shown[1:], strict=False):
            # A tab says "written apart, in a column of its own"; a space, "written next to it".
            text += ("\t" if _gap(before, piece) >= COLUMN_GAP * height else " ") + piece[0].text
        read.append(ParchiText(text, min(p[0].score for p in shown)))
    return read


COLUMN_GAP = 1.5  # pieces at least this many line-heights apart stand in different columns
PRICE_COLUMN = 2  # a column is only judged once it has this many numbers
PRICE_TYPICAL = 10  # a column of numbers whose middle value is this or more is prices, not quantities
_AMOUNT = re.compile(r"^(?P<mark>₹|rs\.?)?\s*(?P<n>\d+(?:\.\d+)?)\s*(?P<tail>/-|₹|rs\.?)?$", re.I)

Placed = tuple[Word, float, float, float]  # a piece and its (left-to-right position, top, bottom) on the levelled page


def _line_height(line: list[Placed]) -> float:
    return _size(max(line, key=lambda p: _size(p[0])[0])[0])[1]


def _gap(before: Placed, after: Placed) -> float:
    """Blank paper between two pieces of one line."""
    return (after[1] - _size(after[0])[0] / 2) - (before[1] + _size(before[0])[0] / 2)


def _price_column(lines: list[list[Placed]]) -> set[int]:
    """The pieces (by id) that are a column of prices at the right of the list, if there is one.

    Many parchis carry what each item costs, and often a total, in a column of their own. Those
    numbers are not how many to bill. The last number of a line, standing apart from what is
    before it, belongs to such a column when at least PRICE_COLUMN lines have one in the same
    place and the column is recognisably money: it carries a currency mark, or the lines have a
    second column of numbers to its left (the quantities), or its middle value is PRICE_TYPICAL
    or more, which quantities on a household list are not. A column that is not recognisably
    money is left alone, and so is everything written next to an item's name."""
    last = []
    for line in lines:
        piece = line[-1]
        amount = _AMOUNT.match(piece[0].text)
        if amount is None:
            continue
        if len(line) > 1 and _gap(line[-2], piece) < COLUMN_GAP * _line_height(line):
            continue  # written next to the item ("Maggi 2"): not a column
        beside_quantity = (
            len(line) > 2 and line[-2][0].text.strip().isdigit() and _gap(line[-3], line[-2]) >= COLUMN_GAP * _line_height(line)
        )
        last.append((piece, float(amount["n"]), bool(amount["mark"] or amount["tail"]), beside_quantity))
    if len(last) < PRICE_COLUMN:
        return set()
    middle = sorted(c[0][1] for c in last)[len(last) // 2]
    reach = 3 * sorted(_size(c[0][0])[1] for c in last)[len(last) // 2]
    column = [c for c in last if abs(c[0][1] - middle) <= reach]
    if len(column) < PRICE_COLUMN:
        return set()
    typical = sorted(c[1] for c in column)[len(column) // 2]
    money = any(c[2] for c in column) or 2 * sum(c[3] for c in column) >= len(column) or typical >= PRICE_TYPICAL
    return {id(c[0]) for c in column} if money else set()


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
            result = [self._second_look(engine, photo, entry) for entry in result or []]
        return rows(parse_ocr_result(result))

    def _second_look(self, engine: Any, photo: Image.Image, entry: Any) -> Any:
        """A piece the reader was unsure of, read again on its own. Returns the entry to use."""
        try:
            points, text, _score, _boxes, _characters, scores = entry
            if not doubtful(text, [float(s) for s in scores]):
                return entry
            xs, ys = [float(p[0]) for p in points], [float(p[1]) for p in points]
            pad_x, pad_y = (max(xs) - min(xs)) * 0.06 + 4, (max(ys) - min(ys)) * 0.15 + 4
            cut = photo.crop(
                (
                    int(max(0, min(xs) - pad_x)),
                    int(max(0, min(ys) - pad_y)),
                    int(min(photo.width, max(xs) + pad_x)),
                    int(min(photo.height, max(ys) + pad_y)),
                )
            )
        except (TypeError, ValueError, IndexError):
            return entry
        import numpy as np

        readings = []
        for view in views(cut):
            out, _ = engine(np.asarray(view.convert("RGB"))[:, :, ::-1], use_det=False, use_cls=False, use_rec=True)
            if out:
                readings.append((str(out[0][0]), float(out[0][1])))
        agreed = agreed_reading(text, readings)
        return entry if agreed is None else [points, agreed[0], agreed[1]]


DOUBTFUL = 0.6  # a character the reader scored below this was close to a guess
AGREE = 4  # of the five views of a piece (see `views`), this many must read it the same way


def doubtful(text: str, scores: list[float]) -> bool:
    """The reader was unsure of a character, or wrote one in a script no parchi here is written in
    (its models also know Chinese: a lone stroke can come back as a Chinese numeral)."""
    return any(s < DOUBTFUL for s in scores) or any(ord(c) > 0x2E7F for c in text)


def views(cut: Image.Image) -> list[Image.Image]:
    """The same piece five ways: as photographed, enlarged, contrast stretched, black and white,
    and enlarged with the contrast stretched. Ink on creased or shaded paper reads differently in
    each; what all of them agree on does not depend on the paper."""
    grey = ImageOps.autocontrast(cut.convert("L"), cutoff=2)
    middle = (sum(grey.getextrema())) / 2
    large = cut.resize((cut.width * 2, cut.height * 2), Image.LANCZOS)
    return [cut, large, grey, grey.point(lambda v: 255 if v > middle else 0), ImageOps.autocontrast(large.convert("L"), cutoff=2)]


def agreed_reading(text: str, readings: list[tuple[str, float]]) -> tuple[str, float] | None:
    """What a second look at one piece settles on, or None to keep the first reading.

    `readings` are (text, score) from reading the piece on its own in different views. The piece
    is only read differently when at least AGREE views give the very same characters, those are
    as many characters as before (a second look may tell an "I" from a "1"; it may not add or
    drop anything, which is what a neighbouring word caught in the cut-out would do), and none is
    in a foreign script. Nothing is ever replaced by rule: only by the reader itself, agreeing."""
    squash = lambda s: "".join(s.split())  # noqa: E731
    seen: dict[str, list[tuple[str, float]]] = {}
    for reading, score in readings:
        seen.setdefault(squash(reading), []).append((reading, score))
    if not seen:
        return None
    characters, same = max(seen.items(), key=lambda kv: len(kv[1]))
    if len(same) < AGREE or characters == squash(text) or len(characters) != len(squash(text)):
        return None
    if any(ord(c) > 0x2E7F for c in characters):
        return None
    best, score = max(same, key=lambda rs: rs[1])
    return " ".join(best.split()), score


_local = RapidOcrParchiReader()


def build_parchi_reader(provider: str) -> ParchiReader:
    """Provider registry. There is no mock and no fallback: anything but "ocr" is switched off."""
    return _local if provider == "ocr" else NotConfiguredParchiReader()
