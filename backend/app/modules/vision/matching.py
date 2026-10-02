"""Evidence fusion: what the provider observed -> which catalog product (if any) it is.

Pure functions, no database and no models. The caller supplies one merchant's catalog as
`Entry` values; nothing here knows any product. Three independent signals are combined:

  visual     relative score of the entry's name against the crop (CLIP; not a probability)
  text       how much of the entry's name was read on the pack (OCR), weighted so that words
             shared by many catalog products count less than distinctive ones
  reference  similarity of the crop to the merchant's reference photos of the entry

Each is a 0..1 support value; they are combined as independent evidence (noisy-OR), so
agreeing signals reinforce each other and one weak signal never decides alone. A look that
could have been checked (the pack's text was readable, or the product has reference photos)
and was confirmed by neither counts for less. The decision then needs enough evidence *and*
enough lead over the runner-up; otherwise the result is ambiguous, unsure or unknown. The
top candidate is never forced.
"""

import math
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Hashable

from app.integrations.types import BoundingBox, Evidence, overlap
from app.modules.vision.schemas import MatchState

MAX_CANDIDATES = 5

# Packaging words say nothing about which product it is.
_NOISE = {"a", "an", "the", "of", "pack", "packet", "box", "bottle", "tube", "can", "jar", "bag", "pouch"}
_UNIT = re.compile(r"(\d+(?:\.\d+)?)\s*(ml|l|g|gm|kg|pcs)\b")
_SIZE = re.compile(r"^\d+(\.\d+)?(ml|l|g|gm|kg|pcs)?$")
_PACK_SIZE = re.compile(r"^\d+(\.\d+)?(ml|l|g|gm|kg)$")


@dataclass(frozen=True)
class MatchingConfig:
    match_score: float = 0.75  # combined evidence needed to preselect a product
    min_score: float = 0.35  # below this nothing in the catalog is supported: unknown
    margin: float = 0.15  # lead over the runner-up needed to call it one product
    reference_floor: float = 0.65  # crop/reference similarity that counts as no support...
    reference_strong: float = 0.85  # ...and as full support (same packaging)
    fuzzy: float = 0.85  # how alike a read word and a name word must be (one OCR slip in a long word)
    min_text_tokens: int = 3  # this many words read on the pack = "the text was readable"
    unconfirmed_look: float = 0.5  # weight of the look when it could be checked and nothing confirmed it
    same_object_iou: float = 0.1  # two boxes for the same product overlapping this much are one packet
    same_object_inside: float = 0.5


@dataclass(frozen=True)
class Entry:
    """One catalog product as the matcher sees it."""

    key: Hashable
    name: str
    references: tuple[tuple[float, ...], ...] = ()  # appearance embeddings (same model as the crop's)


@dataclass(frozen=True)
class Scored:
    key: Hashable
    score: float  # combined evidence, 0..1 (a ranking score, not a calibrated probability)
    visual: float  # for size variants of one product: the variants' combined look
    text: float
    reference: float


@dataclass(frozen=True)
class Decision:
    state: MatchState
    ranked: tuple[Scored, ...]  # the product (matched / low_confidence) or the choices (ambiguous)
    read_text: str = ""
    variants_of: str = ""  # ambiguous only: the choices are sizes of this one product ("which size?")

    @property
    def best(self) -> Scored | None:
        return self.ranked[0] if self.ranked else None


# ---- text ----


def words(text: str) -> list[str]:
    """Normalized words in reading order: lower case, units joined to their number, no packaging words."""
    text = _UNIT.sub(r"\1\2", text.lower())  # "750 ml" -> "750ml"
    return [t for t in re.split(r"[^a-z0-9.]+", text) if t.strip(".") and t not in _NOISE]


def tokens(text: str) -> set[str]:
    return set(words(text))


def _is_minor(token: str) -> bool:
    """Sizes and one/two-letter fragments: often unreadable on a pack and weak identifiers."""
    return len(token) < 3 or bool(_SIZE.match(token))


def token_weights(names: list[str]) -> list[dict[str, float]]:
    """Per name: token -> weight. A word used by k catalog products is worth 1/k (it cannot
    tell them apart); sizes and tiny fragments are worth half."""
    per_name = [tokens(name) for name in names]
    used_by: dict[str, int] = {}
    for toks in per_name:
        for t in toks:
            used_by[t] = used_by.get(t, 0) + 1
    return [{t: (0.5 if _is_minor(t) else 1.0) / used_by[t] for t in toks} for toks in per_name]


# Where glued OCR text is split into words. A capital only starts a word when lower-case letters
# follow it ("FluorideToothpaste"), so stylized logos keep their letters together ("5staR", "StaR").
_WORD_START = re.compile(r"(?<=[a-z])(?=[A-Z][a-z])")
_DIGIT_EDGE = re.compile(r"(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])")  # "5staR" -> "5 staR", "WT70g" -> "WT 70 g"
_LONG = 5  # shorter words must be read exactly: "surf" is not in "surface", "salt" is not "salted"


class ReadText:
    """OCR output prepared for lookups. OCR glues words together ("FluorideToothpaste", "5staR",
    "ANDPEPPERMINTOIL", "TATASALT") and slips on letters ("Cleansel"), so a name word counts as
    read if it is a read word (as printed, or after splitting glued text at word starts and
    between digits and letters) or, when that cannot be mistaken for part of another word, sits
    inside a glued run or is one slip away from a read word."""

    def __init__(self, text: str, fuzzy: float):
        self.words = tokens(text) | tokens(_DIGIT_EDGE.sub(" ", _WORD_START.sub(" ", text)))
        self.squashed = re.sub(r"[^a-z0-9]+", "", text.lower())
        self.fuzzy = fuzzy

    def __len__(self) -> int:
        return sum(1 for w in self.words if len(w) >= 3)

    def has(self, token: str) -> bool:
        if token in self.words:
            return True
        bare = token.replace(".", "")
        if any(c.isdigit() for c in bare):
            # "70g" inside "netwt70g", "5star" for "5 STAR", but not "40g" inside "140g".
            # A lone "5" or "2" only counts as a word of its own.
            return len(bare) >= 3 and re.search(rf"(?<!\d){re.escape(bare)}(?!\d)", self.squashed) is not None
        if len(bare) < _LONG:
            return False
        if bare in self.squashed:
            return True
        return any(
            abs(len(w) - len(bare)) <= 1 and SequenceMatcher(None, bare, w).ratio() >= self.fuzzy for w in self.words
        )

    def read_words(self, name: str) -> set[str]:
        """The words of a catalogue name that were read on the pack."""
        ordered = words(name)
        found = {t for t in ordered if self.has(t)}
        for a, b in zip(ordered, ordered[1:], strict=False):
            # Two neighbouring name words printed (or read) as one: "TATASALT", "GOODDAY".
            run = (a + b).replace(".", "")
            if len(run) >= _LONG and not run.isdigit() and run in self.squashed:
                found |= {a, b}
        return found


def text_support(name: str, weights: dict[str, float], read: ReadText) -> float:
    """Share of the name's weight that was read. `weights` is the name's entry from token_weights."""
    total = sum(weights.values())
    if total <= 0:
        return 0.0
    found = read.read_words(name)
    return sum(w for t, w in weights.items() if t in found) / total


# ---- reference images ----


def cosine(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    if not a or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm > 0 and math.isfinite(dot) else 0.0


def reference_support(embedding: tuple[float, ...], references, config: MatchingConfig) -> float:
    if not embedding or not references:
        return 0.0
    best = max(cosine(embedding, ref) for ref in references)
    span = config.reference_strong - config.reference_floor
    return _unit((best - config.reference_floor) / span) if span > 0 else float(best >= config.reference_strong)


# ---- fusion and decision ----


def _unit(value: float) -> float:
    return min(1.0, max(0.0, value)) if math.isfinite(value) else 0.0


def pack_sizes(name: str) -> set[str]:
    """The pack-size words of a name ("70g", "750ml")."""
    return {t for t in tokens(name) if _PACK_SIZE.match(t)}


def variant_key(name: str) -> tuple[str, ...]:
    """A name without its pack size. Entries with the same key are size variants of one product:
    the same pack design in another size, which the look cannot tell apart."""
    return tuple(t for t in words(name) if not _PACK_SIZE.match(t))


def name_without_size(name: str) -> str:
    return " ".join(w for w in name.split() if not (words(w) and all(_PACK_SIZE.match(t) for t in words(w))))


def score_entries(evidence: Evidence, entries: list[Entry], config: MatchingConfig) -> tuple[list[Scored], ReadText]:
    read = ReadText(evidence.text, config.fuzzy)
    visual = {label.strip().lower(): _unit(score) for label, score in evidence.visual}
    # Size variants share one look: how the name-based score splits between "... 35g" and "... 70g"
    # says nothing about the size, so each variant is scored with the variants' combined look.
    pooled: dict[tuple[str, ...], dict[str, float]] = {}
    for entry in entries:
        label = entry.name.strip().lower()
        pooled.setdefault(variant_key(entry.name), {})[label] = visual.get(label, 0.0)
    weights = token_weights([e.name for e in entries])
    readable = len(read) >= config.min_text_tokens
    scored = []
    for entry, entry_weights in zip(entries, weights, strict=True):
        v = min(1.0, sum(pooled[variant_key(entry.name)].values()))
        t = text_support(entry.name, entry_weights, read) if read.words else 0.0
        r = reference_support(evidence.embedding, entry.references, config)
        checkable = readable or (bool(evidence.embedding) and bool(entry.references))
        look = v * config.unconfirmed_look if checkable and t == 0 and r == 0 else v
        scored.append(Scored(entry.key, round(1 - (1 - look) * (1 - t) * (1 - r), 4), v, round(t, 4), round(r, 4)))
    scored.sort(key=lambda s: -s.score)
    return scored, read


def decide(evidence: Evidence, entries: list[Entry], config: MatchingConfig) -> Decision:
    """`entries` must be one merchant's active catalog."""
    scored, read = score_entries(evidence, entries, config)
    by_key = {e.key: e for e in entries}
    variants: dict[tuple[str, ...], list[Entry]] = {}  # in catalogue order
    for e in entries:
        variants.setdefault(variant_key(e.name), []).append(e)
    # A pack that shows exactly one variant's size is that variant: the other sizes drop out.
    for members in variants.values():
        shown = [e for e in members if pack_sizes(e.name) & read.read_words(e.name)]
        if len(members) > 1 and len(shown) == 1:
            others = {e.key for e in members} - {shown[0].key}
            scored = [s for s in scored if s.key not in others]
            members[:] = shown

    if not scored or scored[0].score < config.min_score:
        return Decision(MatchState.UNMATCHED, (), evidence.text)  # weak evidence is not a match
    best = scored[0]
    entry = by_key[best.key]
    siblings = {e.key for e in variants[variant_key(entry.name)]}
    close = [s for s in scored if best.score - s.score < config.margin and s.score >= config.min_score]
    if any(s.key not in siblings for s in close):
        return Decision(MatchState.AMBIGUOUS, tuple(close[:MAX_CANDIDATES]), evidence.text)
    if len(siblings) > 1:
        # Which size it is cannot be observed: offer every size, in catalogue order, never a guess.
        by_score = {s.key: s for s in scored}
        choices = tuple(by_score[e.key] for e in variants[variant_key(entry.name)])
        return Decision(MatchState.AMBIGUOUS, choices[:MAX_CANDIDATES], evidence.text, name_without_size(entry.name))
    if best.score >= config.match_score and not size_conflict(entry.name, read):
        return Decision(MatchState.MATCHED, (best,), evidence.text)
    return Decision(MatchState.LOW_CONFIDENCE, (best,), evidence.text)


def size_conflict(name: str, read: ReadText) -> bool:
    """The pack shows a pack size, and it is not this product's ("130g" read, product is "200g"):
    probably another variant of the same brand."""
    wanted = pack_sizes(name)
    shown = {w for w in read.words if _PACK_SIZE.match(w)}
    return bool(wanted) and bool(shown) and not (wanted & read.read_words(name))


# ---- one physical packet = one detection ----


_STRENGTH = {MatchState.MATCHED: 3, MatchState.LOW_CONFIDENCE: 2, MatchState.AMBIGUOUS: 1, MatchState.UNMATCHED: 0}


def same_object(
    a: tuple[BoundingBox | None, Decision], b: tuple[BoundingBox | None, Decision], config: MatchingConfig
) -> bool:
    """Two overlapping boxes that read as the same product are one packet seen twice (e.g. the
    whole packet and its logo), not two packets."""
    (box_a, dec_a), (box_b, dec_b) = a, b
    if box_a is None or box_b is None:
        return False
    iou, inside = overlap(box_a, box_b)
    if iou <= config.same_object_iou and inside <= config.same_object_inside:
        return False
    if dec_a.best is None or dec_b.best is None:
        return dec_a.best is None and dec_b.best is None  # two unknown boxes on the same spot
    return dec_a.best.key == dec_b.best.key


def keep_one_per_object(found: list[tuple[BoundingBox | None, Decision]], config: MatchingConfig) -> list[int]:
    """Indexes to keep (in input order): the best-supported detection of each physical object."""
    order = sorted(
        range(len(found)),
        key=lambda i: (-_STRENGTH[found[i][1].state], -(found[i][1].best.score if found[i][1].best else 0.0), i),
    )
    kept: list[int] = []
    for i in order:
        if not any(same_object(found[i], found[k], config) for k in kept):
            kept.append(i)
    return sorted(kept)
