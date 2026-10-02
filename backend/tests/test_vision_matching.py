"""Evidence fusion (app.modules.vision.matching): pure functions, no database, no models.

Catalogs here are made-up test data; the matcher itself knows no product."""

import pytest

from app.integrations.types import BoundingBox, Evidence
from app.modules.vision.matching import (
    Decision,
    Entry,
    MatchingConfig,
    ReadText,
    Scored,
    cosine,
    decide,
    keep_one_per_object,
    reference_support,
    score_entries,
    size_conflict,
    text_support,
    token_weights,
    tokens,
)
from app.modules.vision.schemas import MatchState

CONFIG = MatchingConfig()
CATALOG = ["Butter Croissant 45g", "Glucose Biscuits 250g", "Butter Cookies 100g", "Antiseptic Liquid 125ml", "Star Bar 40g"]


def entries(*names: str, references: dict[str, tuple] | None = None) -> list[Entry]:
    return [Entry(n, n, tuple((references or {}).get(n, ()))) for n in (names or CATALOG)]


def seen(visual: dict[str, float] | None = None, text: str = "", embedding: tuple[float, ...] = ()) -> Evidence:
    ranked = tuple(sorted((visual or {}).items(), key=lambda kv: -kv[1]))
    return Evidence(visual=ranked, text=text, embedding=embedding, embedding_model="m" if embedding else None)


seen_evidence = seen


def read(text: str) -> ReadText:
    return ReadText(text, CONFIG.fuzzy)


# ---- OCR text parsing ----


def test_tokens_normalize_units_and_drop_packaging_words():
    assert tokens("Cola 750 ml Bottle") == {"cola", "750ml"}
    assert tokens("2-Minute Noodles (70 g)") == {"2", "minute", "noodles", "70g"}
    assert tokens("  ... ") == set()


def test_words_shared_across_the_catalog_and_sizes_count_less():
    croissant, _, cookies, *_ = token_weights(CATALOG)
    assert croissant == {"butter": 0.5, "croissant": 1.0, "45g": 0.5}  # "butter" is on two products
    assert cookies["cookies"] == 1.0 and cookies["butter"] == 0.5


@pytest.mark.parametrize(
    ("ocr", "word", "expected"),
    [
        ("BUTTER CROISSANT", "croissant", True),
        ("FluorideToothpaste", "toothpaste", True),  # glued, split at the case change
        ("ANDPEPPERMINTOIL", "peppermint", True),  # glued capitals: a long word inside a run
        ("5STAR", "star", True),  # split at the digit
        ("5STAR", "5", True),
        ("5staR", "star", True),  # stylized logo: mixed case is not a word boundary
        ("5staR", "5", True),
        ("5 Star", "star", True),
        ("StaR", "star", True),
        ("7 UP", "7up", True),  # a name word made of digits and letters, read with a gap
        ("7UP", "7up", True),
        ("3in1 Coffee", "3in1", True),
        ("WT70g", "70g", True),
        ("40 G", "40g", True),
        ("140g", "40g", False),  # part of a bigger number
        ("1250", "250", False),
        ("NET 250", "250", True),
        ("Cleansel", "cleanser", True),  # one OCR slip in a long word
        ("NET WT70g", "70g", True),
        ("Net Wt 70 g", "70g", True),
        ("Surface", "surf", False),  # short words must be read exactly
        ("Salt", "salted", False),
        ("Magic", "maggi", False),  # a different word, not a slip
        ("50", "5", False),
        ("140g", "70g", False),
        ("", "butter", False),
    ],
)
def test_reading_a_name_word_in_ocr_text(ocr, word, expected):
    assert read(ocr).has(word) is expected


def test_text_support_is_the_share_of_the_name_that_was_read():
    weights = dict(zip(CATALOG, token_weights(CATALOG), strict=True))
    full = read("BUTTER CROISSANT 45g")
    support = lambda name, seen: text_support(name, weights[name], seen)  # noqa: E731
    assert support("Butter Croissant 45g", full) == 1.0
    assert support("Butter Cookies 100g", full) == pytest.approx(0.25)  # only the shared word
    assert support("Glucose Biscuits 250g", full) == 0.0
    assert support("Butter Croissant 45g", read("CROISSANT")) == pytest.approx(0.5)
    assert text_support("Anything", {}, full) == 0.0


@pytest.mark.parametrize(
    ("name", "ocr", "read_words"),
    [
        # numeric / alphanumeric names, as OCR actually returns stylized logos
        ("Caramel 5 Star 40g", "5staR", {"5", "star"}),
        ("Caramel 5 Star 40g", "5STAR", {"5", "star"}),
        ("Caramel 5 Star 40g", "5 Star", {"5", "star"}),
        ("Caramel 5 Star 40g", "Oadbay 5staR ★★★★★ NET WT 40 g", {"5", "star", "40g"}),  # the size survives
        ("Caramel 5 Star 40g", "5staR 20% XTRA 48g", {"5", "star"}),  # another size is not this size
        ("Caramel 5Star 40g", "5 STAR", {"5star"}),  # the catalogue wrote it glued, the pack did not
        ("2-Minute Noodles 70g", "2-MINUTE NOODLES 70g", {"2", "minute", "noodles", "70g"}),
        ("2-Minute Noodles 70g", "2MINUTE Noodles", {"2", "minute", "noodles"}),
        ("Lemon 7Up 250ml", "7UP LEMON 250 ML", {"lemon", "7up", "250ml"}),
        ("Vitamin B12 Tonic 100ml", "VITAMIN B12", {"vitamin", "b12"}),
        ("Cola 1.5L", "COLA 1.5 L", {"cola", "1.5l"}),
        ("Star Anise 50g", "5staR", {"star"}),  # the word supports every product that has it; weights decide
        # short name words glued together by the OCR
        ("Sea Salt 1kg", "SEASALT", {"sea", "salt"}),
        ("Good Day Cashew 100g", "GOODDAY CASHEW", {"good", "day", "cashew"}),
        ("Sea Salt 1kg", "SEASON SALTED", set()),  # neither word is there
    ],
)
def test_which_words_of_a_catalogue_name_were_read(name, ocr, read_words):
    assert read(ocr).read_words(name) == read_words


def test_stylized_logo_text_supports_the_right_catalogue_product():
    """The reported failure: the logo was read ("5staR") but only "5" counted, so the product got
    too little text support to be recognized."""
    catalog = ["Caramel 5 Star 40g", "Strong Teeth Paste 200g", "Glucose Biscuits 250g"]
    weights = dict(zip(catalog, token_weights(catalog), strict=True))
    for ocr in ("5staR", "5STAR", "5 Star", "5star ★★★★★"):
        seen = read(ocr)
        assert text_support(catalog[0], weights[catalog[0]], seen) == pytest.approx(0.5), ocr  # 5 + star of 4 words
        assert text_support(catalog[1], weights[catalog[1]], seen) == 0.0
    weak_look = {"Strong Teeth Paste 200g": 0.3, "Caramel 5 Star 40g": 0.25}
    decision = decide(seen_evidence(weak_look, "5staR"), [Entry(n, n) for n in catalog], CONFIG)
    assert [s.key for s in decision.ranked] == ["Caramel 5 Star 40g"] and decision.state != MatchState.UNMATCHED


def test_size_conflict_only_when_another_size_is_shown():
    assert size_conflict("Tooth Gel 200g", read("TOOTH GEL NET WT 130g")) is True
    assert size_conflict("Tooth Gel 200g", read("TOOTH GEL 200g 130g")) is False  # its own size is there
    assert size_conflict("Tooth Gel 200g", read("TOOTH GEL")) is False  # no size read
    assert size_conflict("Tooth Gel", read("130g")) is False  # the product names no size


# ---- reference similarity ----


def test_cosine_and_reference_support_are_safe_on_bad_input():
    assert cosine((1.0, 0.0), (1.0, 0.0)) == pytest.approx(1.0)
    assert cosine((1.0, 0.0), (0.0, 1.0)) == 0.0
    assert cosine((), ()) == 0.0 and cosine((1.0,), (1.0, 2.0)) == 0.0 and cosine((0.0, 0.0), (1.0, 1.0)) == 0.0
    assert cosine((float("nan"), 1.0), (1.0, 1.0)) == 0.0

    a = (1.0, 0.0)
    assert reference_support(a, ((1.0, 0.0),), CONFIG) == 1.0
    assert reference_support(a, ((0.75, 0.6614),), CONFIG) == pytest.approx(0.5, abs=0.01)  # cos 0.75, between floor and strong
    assert reference_support(a, ((0.0, 1.0), (1.0, 0.0)), CONFIG) == 1.0  # best of several photos
    assert reference_support(a, ((0.5, 0.866),), CONFIG) == 0.0  # below the floor: no support
    assert reference_support((), ((1.0, 0.0),), CONFIG) == 0.0 and reference_support(a, (), CONFIG) == 0.0


# ---- fusion ----


def test_signals_combine_as_independent_evidence():
    [top, *_], _ = score_entries(seen({"Butter Croissant 45g": 0.5}, "CROISSANT"), entries(), CONFIG)
    assert (top.key, top.visual, top.text, top.reference) == ("Butter Croissant 45g", 0.5, 0.5, 0.0)
    assert top.score == pytest.approx(0.75)  # 1 - (1 - 0.5)(1 - 0.5): agreeing signals reinforce
    scored, _ = score_entries(seen({"Not In Catalog": 0.99, "butter croissant 45G ": 0.4}), entries(), CONFIG)
    assert scored[0].visual == 0.4 and all(s.key in CATALOG for s in scored)  # only catalog entries are ever scored
    scored, _ = score_entries(seen({"Star Bar 40g": float("nan"), "Butter Cookies 100g": 7.0}), entries(), CONFIG)
    assert {s.key: s.visual for s in scored}["Star Bar 40g"] == 0.0 and scored[0].score == 1.0  # clamped to 0..1


# ---- decisions: match / ambiguous / unsure / unknown ----


def state(evidence: Evidence, catalog: list[Entry] | None = None, config: MatchingConfig = CONFIG):
    decision = decide(evidence, catalog or entries(), config)
    return decision.state, [s.key for s in decision.ranked]


def test_weak_evidence_is_unknown_even_for_the_top_candidate():
    assert state(seen({"Antiseptic Liquid 125ml": 0.23, "Star Bar 40g": 0.21})) == (MatchState.UNMATCHED, [])
    assert state(seen()) == (MatchState.UNMATCHED, [])
    assert state(seen({"Star Bar 40g": 0.99}), catalog=[Entry("x", "Something Else")]) == (MatchState.UNMATCHED, [])
    assert decide(seen({"Star Bar 40g": 0.99}), [], CONFIG).state == MatchState.UNMATCHED  # empty catalog


def test_close_candidates_are_ambiguous_never_the_top_one():
    assert state(seen({"Butter Croissant 45g": 0.41, "Glucose Biscuits 250g": 0.40})) == (
        MatchState.AMBIGUOUS,
        ["Butter Croissant 45g", "Glucose Biscuits 250g"],
    )
    # Even strong evidence is ambiguous when two products are equally supported.
    assert state(seen({"Butter Croissant 45g": 0.5, "Butter Cookies 100g": 0.45}, "BUTTER"))[0] == MatchState.AMBIGUOUS
    # A weak runner-up below the floor is not offered as a choice.
    assert state(seen({"Butter Croissant 45g": 0.45, "Glucose Biscuits 250g": 0.33})) == (
        MatchState.LOW_CONFIDENCE,
        ["Butter Croissant 45g"],
    )


def test_enough_evidence_with_a_clear_lead_is_a_match():
    assert state(seen({"Star Bar 40g": 0.9})) == (MatchState.MATCHED, ["Star Bar 40g"])
    assert state(seen({"Antiseptic Liquid 125ml": 0.23, "Star Bar 40g": 0.21}, "5STAR BAR")) == (
        MatchState.MATCHED,
        ["Star Bar 40g"],
    )
    assert state(seen(text="GLUCOSE BISCUITS")) == (MatchState.MATCHED, ["Glucose Biscuits 250g"])  # text alone


def test_moderate_evidence_with_a_clear_lead_is_unsure():
    assert state(seen({"Star Bar 40g": 0.52})) == (MatchState.LOW_CONFIDENCE, ["Star Bar 40g"])
    assert state(seen({"Antiseptic Liquid 125ml": 0.23, "Star Bar 40g": 0.21}, "STAR")) == (
        MatchState.LOW_CONFIDENCE,
        ["Star Bar 40g"],
    )


def test_a_strong_look_needs_confirmation_when_the_checkable_evidence_disagrees():
    look = {"Star Bar 40g": 0.9}
    assert state(seen(look, "CRUNCHY PEANUT WAFER"))[0] == MatchState.LOW_CONFIDENCE  # readable, and not its name
    assert state(seen(look, "OK"))[0] == MatchState.MATCHED  # too little text to count as a check
    assert state(seen(look, "STAR BAR 80g"))[0] == MatchState.LOW_CONFIDENCE  # another size of it

    red, blue = (1.0, 0.0), (0.0, 1.0)
    with_photo = entries(references={"Star Bar 40g": (red,)})
    assert state(seen(look, embedding=red), with_photo)[0] == MatchState.MATCHED
    assert state(seen(look, embedding=blue), with_photo)[0] == MatchState.LOW_CONFIDENCE  # unlike its photos


def test_a_look_that_readable_text_does_not_confirm_counts_for_less():
    """A packet that is not in the catalog: the nearest-looking product is a moderate guess and
    the pack clearly says something else -> unknown, not 'unsure: <nearest product>?'."""
    look = {"Star Bar 40g": 0.64, "Butter Cookies 100g": 0.05}
    assert state(seen(look)) == (MatchState.LOW_CONFIDENCE, ["Star Bar 40g"])  # nothing to check it against
    assert state(seen(look, "IODISED SALT VACUUM EVAPORATED")) == (MatchState.UNMATCHED, [])
    best = decide(seen({"Star Bar 40g": 0.9}, "IODISED SALT VACUUM EVAPORATED"), entries(), CONFIG).best
    assert (best.visual, best.score) == (0.9, 0.45)  # reported as observed; counted at half
    assert state(seen(look, "IODISED SALT"), config=MatchingConfig(unconfirmed_look=1.0))[0] == MatchState.LOW_CONFIDENCE


def test_reference_photos_alone_can_identify_a_product():
    red, blue = (1.0, 0.0), (0.0, 1.0)
    catalog = entries(references={"Star Bar 40g": (red,), "Butter Cookies 100g": (blue,)})
    assert state(seen(embedding=red), catalog) == (MatchState.MATCHED, ["Star Bar 40g"])
    assert state(seen(embedding=blue), catalog) == (MatchState.MATCHED, ["Butter Cookies 100g"])
    both = entries(references={"Star Bar 40g": (red,), "Butter Cookies 100g": (red,)})
    assert state(seen(embedding=red), both)[0] == MatchState.AMBIGUOUS  # two products with the same packaging


def test_thresholds_are_configuration_not_product_rules():
    evidence = seen({"Star Bar 40g": 0.6, "Butter Cookies 100g": 0.5})
    assert state(evidence)[0] == MatchState.AMBIGUOUS
    assert state(evidence, config=MatchingConfig(margin=0.05))[0] == MatchState.LOW_CONFIDENCE
    assert state(evidence, config=MatchingConfig(margin=0.05, match_score=0.6))[0] == MatchState.MATCHED
    assert state(evidence, config=MatchingConfig(min_score=0.7))[0] == MatchState.UNMATCHED


def test_a_new_catalog_product_is_matched_without_any_code_change():
    catalog = entries(*CATALOG, "Zesty Lemon Pickle 300g")
    assert state(seen(text="ZESTY LEMON PICKLE"), catalog) == (MatchState.MATCHED, ["Zesty Lemon Pickle 300g"])


# ---- size variants: the same product in another pack size ----

SMALL, LARGE = "Instant Noodles 35g", "Instant Noodles 70g"
SIZES = [SMALL, LARGE, "Glucose Biscuits 250g"]


def test_size_variants_are_one_ambiguous_group_when_the_size_is_not_read():
    """The look cannot see a pack size, so how it splits between the sizes is noise: whatever the
    split, the answer is 'which size?' with both sizes, in catalogue order."""
    for look35, look70 in ((0.68, 0.31), (0.64, 0.35), (0.60, 0.39), (0.47, 0.53), (0.27, 0.28)):
        for text in ("INSTANT NOODLES", "INSTANT", ""):
            decision = decide(seen({SMALL: look35, LARGE: look70}, text), entries(*SIZES), CONFIG)
            assert decision.state == MatchState.AMBIGUOUS, (look35, look70, text)
            assert [s.key for s in decision.ranked] == [SMALL, LARGE]  # never ordered by the noisy look
            assert decision.variants_of == "Instant Noodles"
            assert decision.ranked[0].visual == decision.ranked[1].visual == pytest.approx(look35 + look70)

    reordered = decide(seen({SMALL: 0.3, LARGE: 0.6}, "INSTANT NOODLES"), entries(LARGE, SMALL), CONFIG)
    assert [s.key for s in reordered.ranked] == [LARGE, SMALL]  # the catalogue's order
    # A size that belongs to neither variant does not pick one either.
    assert state(seen({SMALL: 0.6, LARGE: 0.3}, "INSTANT NOODLES 140g"), entries(*SIZES)) == (
        MatchState.AMBIGUOUS,
        [SMALL, LARGE],
    )
    # An entry without a size and the same product with one are variants too.
    assert state(seen({"Fizzy Cola": 0.05, "Fizzy Cola 750ml": 0.85}), entries("Fizzy Cola", "Fizzy Cola 750ml")) == (
        MatchState.AMBIGUOUS,
        ["Fizzy Cola", "Fizzy Cola 750ml"],
    )
    # The group still has to beat other products: a close different product is ordinary ambiguity.
    mixed = decide(seen({SMALL: 0.3, LARGE: 0.2, "Glucose Biscuits 250g": 0.45}), entries(*SIZES), CONFIG)
    assert mixed.state == MatchState.AMBIGUOUS and mixed.variants_of == ""
    assert {s.key for s in mixed.ranked} == set(SIZES)
    # And weak evidence for the whole group is still unknown.
    assert state(seen({SMALL: 0.1, LARGE: 0.1}), entries(*SIZES)) == (MatchState.UNMATCHED, [])


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("INSTANT NOODLES NET WT 35g", SMALL),
        ("INSTANT NOODLES 35 G", SMALL),
        ("35g", SMALL),
        ("INSTANT NOODLES NET WT 70g", LARGE),
        ("INSTANT NOODLES WT70g", LARGE),
    ],
)
def test_the_size_read_on_the_pack_selects_that_variant(text, expected):
    for look in ({SMALL: 0.6, LARGE: 0.3}, {SMALL: 0.3, LARGE: 0.6}):  # whichever size the look leans to
        decision = decide(seen(look, text), entries(*SIZES), CONFIG)
        assert (decision.state, [s.key for s in decision.ranked]) == (MatchState.MATCHED, [expected]), (look, text)
        assert decision.variants_of == ""
    # Both sizes legible on the pack (e.g. "70g + 35g extra"): the size decides nothing.
    assert state(seen({SMALL: 0.6, LARGE: 0.3}, "INSTANT NOODLES 35g 70g"), entries(*SIZES))[0] == MatchState.AMBIGUOUS


def test_variants_that_differ_by_a_word_the_look_can_see_are_not_grouped():
    """Different flavours have different artwork: the look may tell them apart, as before."""
    salted, masala = "Potato Chips Classic Salted 52g", "Potato Chips Magic Masala 52g"
    catalog = entries(salted, masala, "Glucose Biscuits 250g")
    clear = decide(seen({salted: 0.8, masala: 0.1}), catalog, CONFIG)
    assert (clear.state, [s.key for s in clear.ranked]) == (MatchState.MATCHED, [salted])
    assert clear.best.visual == 0.8  # its own look, not pooled with the other flavour
    assert state(seen({salted: 0.2, masala: 0.2}, "POTATO CHIPS MAGIC MASALA"), catalog) == (MatchState.MATCHED, [masala])
    close = decide(seen({salted: 0.5, masala: 0.45}), catalog, CONFIG)
    assert close.state == MatchState.AMBIGUOUS and close.variants_of == ""  # ordinary "too close to call"
    # Same size, different product: not variants.
    assert state(seen({"Star Bar 40g": 0.9, "Nut Bar 40g": 0.05}), entries("Star Bar 40g", "Nut Bar 40g")) == (
        MatchState.MATCHED,
        ["Star Bar 40g"],
    )


# ---- one physical packet = one detection ----


def decided(key: str | None, score: float = 0.9, state: MatchState = MatchState.MATCHED) -> Decision:
    if key is None:
        return Decision(MatchState.UNMATCHED, ())
    return Decision(state, (Scored(key, score, score, 0.0, 0.0),))


def test_overlapping_boxes_of_one_product_keep_only_the_best_supported():
    left, shifted, far = BoundingBox(0.1, 0.1, 0.4, 0.4), BoundingBox(0.3, 0.1, 0.4, 0.4), BoundingBox(0.6, 0.6, 0.3, 0.3)
    logo = BoundingBox(0.2, 0.2, 0.1, 0.1)  # inside `left`

    assert keep_one_per_object([(left, decided("a", 0.8)), (shifted, decided("a", 0.9))], CONFIG) == [1]
    assert keep_one_per_object([(left, decided("a")), (logo, decided("a", 0.5, MatchState.LOW_CONFIDENCE))], CONFIG) == [0]
    assert keep_one_per_object([(left, decided("a")), (far, decided("a"))], CONFIG) == [0, 1]  # two packets
    assert keep_one_per_object([(left, decided("a")), (shifted, decided("b"))], CONFIG) == [0, 1]  # two products
    assert keep_one_per_object([(left, decided(None)), (shifted, decided(None)), (far, decided(None))], CONFIG) == [0, 2]
    assert keep_one_per_object([(left, decided("a")), (logo, decided(None))], CONFIG) == [0, 1]  # unknown is not "a"
    assert keep_one_per_object([(None, decided("a")), (None, decided("a"))], CONFIG) == [0, 1]  # no boxes: no geometry
    assert keep_one_per_object([], CONFIG) == []
