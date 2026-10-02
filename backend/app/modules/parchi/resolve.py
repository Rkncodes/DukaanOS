"""Parchi text -> one merchant's catalogue. Pure functions: the caller supplies the products.

A written request names a product loosely ("Maggi", "parle g", "colgate paste"). A product is
a candidate when its name contains words of the request; it is *the* match only when it is the
single product containing every word exactly as written. Several such products, a misspelt
word, or words the catalogue does not have all go back to the merchant: nothing is guessed.
"""

from dataclasses import dataclass
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Hashable

from app.modules.parchi.parsing import ParsedLine, Reading
from app.modules.vision.matching import words  # shared name normalization ("750 ml" -> "750ml")
from app.modules.vision.schemas import MatchState

MAX_CANDIDATES = 5
SPELLING = 0.8  # how alike a written word and a name word must be to count as a misspelling
MIN_SHARE = 0.5  # a candidate must explain at least this share of the written words


@dataclass(frozen=True)
class Entry:
    key: Hashable
    name: str


@dataclass(frozen=True)
class Candidate:
    key: Hashable
    share: float  # share of the written words found in the product's name
    exact: bool  # every found word was found exactly as written (no misspelling allowed for)
    found: tuple[str, ...]


@dataclass(frozen=True)
class Resolution:
    quantity: Decimal | None  # None: the line gives no reliable quantity; the merchant must enter it
    description: str
    state: MatchState
    candidates: tuple[Candidate, ...]  # the match (matched / low_confidence) or the choices (ambiguous)
    matched_words: tuple[str, ...] = ()
    unmatched_words: tuple[str, ...] = ()

    @property
    def confidence(self) -> float | None:
        return self.candidates[0].share if self.candidates else None


def _singular(word: str) -> str:
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def _same(written: str, name_word: str) -> bool:
    return written == name_word or _singular(written) == _singular(name_word)


def _misspelt(written: str, name_word: str) -> bool:
    if min(len(written), len(name_word)) < 4 or written[0] != name_word[0]:
        return False
    return SequenceMatcher(None, written, name_word).ratio() >= SPELLING


def _candidate(written: list[str], entry: Entry) -> Candidate | None:
    name_words = words(entry.name)
    found, exact = [], True
    for w in written:
        if any(_same(w, n) for n in name_words):
            found.append(w)
        elif any(_misspelt(w, n) for n in name_words):
            found.append(w)
            exact = False
    # A number or a one-letter fragment alone ("2", "g", "250g") does not make a product a candidate.
    if not any(len(w) > 1 and not w[0].isdigit() for w in found):
        return None
    return Candidate(entry.key, len(found) / len(written), exact, tuple(found))


def match(description: str, entries: list[Entry]) -> tuple[MatchState, tuple[Candidate, ...], list[str]]:
    """`entries` must be one merchant's active catalogue."""
    written = list(dict.fromkeys(words(description)))
    if not written:
        return MatchState.UNMATCHED, (), written
    named = [e for e in entries if words(e.name) == words(description)]
    if len(named) == 1:  # the product's whole name was written
        return MatchState.MATCHED, (Candidate(named[0].key, 1.0, True, tuple(written)),), written
    found = [c for c in (_candidate(written, e) for e in entries) if c is not None and c.share >= MIN_SHARE]
    found.sort(key=lambda c: (-c.share, not c.exact))  # stable: catalogue order within a tier
    if not found:
        return MatchState.UNMATCHED, (), written
    full = [c for c in found if c.share == 1.0 and c.exact]
    if len(full) == 1:
        return MatchState.MATCHED, (full[0],), written
    if len(full) > 1:
        return MatchState.AMBIGUOUS, tuple(full[:MAX_CANDIDATES]), written
    best = [c for c in found if c.share == found[0].share]
    if len(best) == 1:
        return MatchState.LOW_CONFIDENCE, (best[0],), written
    return MatchState.AMBIGUOUS, tuple(best[:MAX_CANDIDATES]), written


def _number_may_be_part_of_name(reading: Reading, raw_words: list[str], candidates, by_key: dict) -> bool:
    """ "5 Star", "Maggi 2": the bare number and the word next to it stand together, in that
    order, in a candidate product's name ("Cadbury 5 Star", "Maggi 2-Minute Noodles")."""
    if reading.position is None or len(raw_words) < 2:
        return False
    pair = tuple(raw_words[:2]) if reading.position == "leading" else tuple(raw_words[-2:])
    for candidate in candidates:
        name_words = words(by_key[candidate.key].name)
        if any(tuple(name_words[i : i + 2]) == pair for i in range(len(name_words) - 1)):
            return True
    return False


def resolve(line: ParsedLine, entries: list[Entry]) -> Resolution:
    by_key = {e.key: e for e in entries}
    whole = line.readings[-1]
    raw_words = words(whole.description)
    chosen: Reading = whole
    _, as_written, _ = match(whole.description, entries)
    for reading in line.readings[:-1]:
        if reading.marked:
            chosen = reading
            break
        if not _number_may_be_part_of_name(reading, raw_words, as_written, by_key):
            chosen = reading
            break
    state, candidates, written = match(chosen.description, entries)
    found = set(candidates[0].found) if candidates else set()
    return Resolution(
        quantity=chosen.quantity,
        description=chosen.description,
        state=state,
        candidates=candidates,
        matched_words=tuple(w for w in written if w in found),
        unmatched_words=tuple(w for w in written if w not in found),
    )
