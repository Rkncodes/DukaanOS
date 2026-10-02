"""Spoken transcript -> item lines ("add two Maggi and 5 star two" -> "2 Maggi", "5 star 2").

Speech has no line breaks and little punctuation, so an item ends where the next quantity is
said. Only the catalogue can tell whether a number is a quantity or part of a product's name
("5 Star", "Maggi 2-Minute Noodles"), so the caller passes the merchant's product names: no
product is known here. Each line is then read and matched like a written parchi line
(app.modules.parchi), which is where a quantity is taken or left for the merchant to enter.
"""

import re
from collections.abc import Iterable

from app.modules.vision.matching import words  # shared name normalization

NUMBER_WORDS = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6",
    "seven": "7", "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12",
}  # fmt: skip
_CONNECTORS = {"and", "plus", "then", "also", "&"}
_FILLER = {"add", "please", "give", "me", "i", "want", "need", "put", "get", "ok", "okay"}
_COUNT_UNITS = {"pc", "pcs", "piece", "pieces", "pkt", "pkts", "packet", "packets", "pack", "packs", "dozen"}
_SIZE_UNITS = {"kg", "kgs", "g", "gm", "gms", "gram", "grams", "ml", "l", "ltr", "litre", "litres", "liter", "liters"}

_NUMBER = re.compile(r"^\d+(?:\.\d+)?$")
_CLAUSE = re.compile(r"[,;\n]+|\.(?!\d)")  # "1.5" stays whole
_TO_THE_BILL = re.compile(r"\b(?:to|in|into|on)\s+(?:(?:the|my)\s+)?(?:bill|cart)\b", re.I)


def _word(token: str) -> str:
    return token.lower().strip(".")


class _Names:
    """What the catalogue's names say about numbers and "and": which words stand side by side."""

    def __init__(self, names: Iterable[str]):
        self.words: set[str] = set()
        self.pairs: set[tuple[str, str]] = set()
        self.endings: set[tuple[str, str]] = set()
        for name in names:
            name_words = [w for w in words(name) if w != "and"]  # "Hide & Seek" and "Hide and Seek" alike
            self.words.update(name_words)
            self.pairs.update(zip(name_words, name_words[1:], strict=False))
            if len(name_words) > 1:
                self.endings.add((name_words[-2], name_words[-1]))

    def number_in_name(self, number: str, before: str | None, after: str | None) -> bool:
        """ "5" before "star", "2" before "minute", or a name's last word after the one before it."""
        return (after is not None and (number, after) in self.pairs) or (
            before is not None and (before, number) in self.endings
        )


def _chunks(clause: str, names: _Names) -> list[list[tuple[str, bool]]]:
    """Tokens as (text, is a quantity), cut at "and"-like words unless the catalogue joins them."""
    tokens = [t.strip("?!\"'()") for t in clause.split()]
    tokens = [t for t in tokens if t and (_word(t) not in _FILLER or _word(t) in names.words)]
    chunks: list[list[tuple[str, bool]]] = [[]]
    for i, token in enumerate(tokens):
        low = _word(token)
        previous = tokens[i - 1] if i > 0 else ""
        following = tokens[i + 1] if i + 1 < len(tokens) else ""
        before = (words(previous) or [None])[-1]  # as the catalogue's names are compared
        after = (words(following) or [None])[0]
        if low in _CONNECTORS:
            if not (before and after and (before, after) in names.pairs):  # not "hide and seek"
                chunks.append([])
            continue
        if low == "of" and _word(previous) in _COUNT_UNITS:  # "two packets of ..."
            continue
        digits = NUMBER_WORDS.get(low, low)
        if not _NUMBER.match(digits):
            chunks[-1].append((token, False))
        elif low != digits and names.number_in_name(low, before, after):
            chunks[-1].append((token, False))  # the name itself spells the number as a word
        else:
            in_name = _word(following) in _SIZE_UNITS or names.number_in_name(digits, before, after)
            chunks[-1].append((digits, not in_name))
    return [chunk for chunk in chunks if chunk]


def _items(chunk: list[tuple[str, bool]]) -> list[str]:
    """ "2 maggi 1 coke": a quantity said first starts each item. "maggi 2 coke 1": said last, it ends each."""
    leading = chunk[0][1]
    items: list[list[str]] = [[]]
    for i, (text, is_quantity) in enumerate(chunk):
        if leading and is_quantity and items[-1]:
            items.append([])
        items[-1].append(text)
        unit_follows = i + 1 < len(chunk) and _word(chunk[i + 1][0]) in _COUNT_UNITS  # "maggi 2 packets"
        closes = is_quantity or (i > 0 and chunk[i - 1][1] and _word(text) in _COUNT_UNITS)
        if not leading and closes and not unit_follows:
            items.append([])
    return [" ".join(item) for item in items if item]


def split_items(transcript: str, names: Iterable[str] = ()) -> list[str]:
    """`names` must be one merchant's product names. Number words become digits ("two" -> "2")."""
    catalogue = _Names(names)
    lines = []
    for clause in _CLAUSE.split(_TO_THE_BILL.sub(" ", transcript)):
        for chunk in _chunks(clause, catalogue):
            lines.extend(item for item in _items(chunk) if re.search(r"[^\W\d_]", item))
    return lines
