"""Parchi lines -> (what was asked for, how many). Pure text handling: no catalogue, no OCR.

A quantity is only taken when the line says so. A marked quantity ("x2", "- 2", "2 pkt") is
certain. A bare number at the start or end of a line ("2 Maggi", "Maggi 2") is a *possible*
quantity: it may also be part of a product's name ("5 Star"), which only the catalogue can
tell, so the resolver decides (app.modules.parchi.resolve). Numbers with a size unit ("1 kg",
"750 ml") describe the product, not the count. Nothing is ever assumed to be 1.
"""

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

MAX_QUANTITY = Decimal(999)

_NUMBER = r"\d+(?:\.\d{1,3})?"
_COUNT_UNIT = r"(?:pcs?|pieces?|pkts?|packets?|packs?|nos?|nag|dozen|dz)"
_SIZE_UNIT = r"(?:kg|kgs|g|gm|gms|gram|grams|ml|l|ltr|litre|litres|liter|liters|rs|inr)"
_DOZEN = re.compile(r"^(?:dozen|dz)$", re.I)

_BULLET = re.compile(r"^\s*(?:[-*•·>]+|\[\s?\])\s*")
_NUMBERING = re.compile(r"^\s*(\d{1,2})\s*[.)]\s*(?=\S)")
_MARKED = [
    # "2 x Maggi", "2x Maggi", "2 pkt Maggi", "2 dozen eggs"
    re.compile(rf"^(?P<n>{_NUMBER})(?:\s*[×*]\s*|\s*x\s+|\s*(?P<unit>{_COUNT_UNIT})\b\.?\s+)(?P<rest>\S.*)$", re.I),
    # "Maggi x2", "Maggi x 2", "Maggi 2 pkt", "Maggi - 2", "Maggi: 2 pcs", "Maggi = 2", "Maggi (2)"
    re.compile(rf"^(?P<rest>.*\S)\s+[x×*]\s*(?P<n>{_NUMBER})$", re.I),
    re.compile(rf"^(?P<rest>.*\S)\s+(?P<n>{_NUMBER})\s*(?P<unit>{_COUNT_UNIT})\b\.?$", re.I),
    re.compile(rf"^(?P<rest>.*\S)\s*[-–—:=]+\s*(?P<n>{_NUMBER})\s*(?P<unit>{_COUNT_UNIT})?\.?$", re.I),
    re.compile(rf"^(?P<rest>.*\S)\s*\(\s*(?P<n>{_NUMBER})\s*(?P<unit>{_COUNT_UNIT})?\s*\)$", re.I),
]
_LEADING = re.compile(rf"^(?P<n>{_NUMBER})\s+(?!{_SIZE_UNIT}\b)(?P<rest>\S.*)$", re.I)
_TRAILING = re.compile(rf"^(?P<rest>.*\S)\s+(?P<n>{_NUMBER})$", re.I)


@dataclass(frozen=True)
class Reading:
    """One way to read a line: this many of that."""

    quantity: Decimal | None
    description: str
    marked: bool = False  # the line marks the number as a count ("x2", "2 pkt"): not part of a name
    position: str | None = None  # where a bare number stood: "leading" or "trailing"


@dataclass(frozen=True)
class ParsedLine:
    raw_text: str
    readings: tuple[Reading, ...]  # most likely first; the last one is always "no quantity given"


def _quantity(number: str, unit: str | None = None) -> Decimal | None:
    try:
        value = Decimal(number)
    except InvalidOperation:
        return None
    if unit and _DOZEN.match(unit):
        value *= 12
    return value if 0 < value <= MAX_QUANTITY else None


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip(" \t,;.:=-–—")


def parse_line(text: str, *, raw_text: str | None = None) -> ParsedLine | None:
    """None for lines that cannot be an item (no letters: totals, phone numbers, dates).
    `raw_text` is the line as read, when `text` already had its list numbering removed."""
    raw = re.sub(r"\s+", " ", text if raw_text is None else raw_text).strip()
    body = _clean(_BULLET.sub("", re.sub(r"\s+", " ", text).strip()))
    if not re.search(r"[^\W\d_]", body):
        return None
    whole = Reading(None, body)
    for pattern in _MARKED:
        match = pattern.match(body)
        if match and re.search(r"[^\W\d_]", match["rest"]):
            quantity = _quantity(match["n"], match.groupdict().get("unit"))
            if quantity is not None:
                return ParsedLine(raw, (Reading(quantity, _clean(match["rest"]), marked=True), whole))
    readings = []
    for pattern, position in ((_LEADING, "leading"), (_TRAILING, "trailing")):
        match = pattern.match(body)
        if match and re.search(r"[^\W\d_]", match["rest"]):
            quantity = _quantity(match["n"])
            if quantity is not None:
                readings.append(Reading(quantity, _clean(match["rest"]), position=position))
    return ParsedLine(raw, (*readings, whole))


def strip_numbering(lines: list[str]) -> list[str]:
    """ "1. Maggi", "2. Coke", "3. Salt": a list counted 1, 2, 3 from its first line is numbered;
    those numbers are not quantities."""
    numbers = [_NUMBERING.match(line) for line in lines]
    counted = 0
    for match in numbers:
        if match is None or int(match[1]) != counted + 1:
            break
        counted += 1
    if counted < 2:
        return lines
    return [_NUMBERING.sub("", line, count=1) if i < counted else line for i, line in enumerate(lines)]


def parse_lines(lines: list[str]) -> list[ParsedLine]:
    written = [line for line in lines if line and line.strip()]
    parsed = (parse_line(line, raw_text=raw) for line, raw in zip(strip_numbering(written), written, strict=True))
    return [line for line in parsed if line is not None]
