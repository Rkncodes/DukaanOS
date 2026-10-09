"""Parchi -> Bill: reading lines, quantities, merchant-scoped catalogue matching, and confirmed
lines entering the existing cart through the existing recognized-items path.

The reader is replaced at its boundary by FakeReader, which only hands back lines of *text*
(what an OCR engine produces); quantities and catalogue matches are always decided by the code
under test. The real OCR engine runs only in the opt-in smoke test at the bottom.
"""

import math
import os
from decimal import Decimal
from io import BytesIO

import pytest
from PIL import Image

from app.core.config import Settings, settings
from app.core.enums import InputSource
from app.integrations.ocr import (
    NotConfiguredParchiReader,
    ParchiText,
    RapidOcrParchiReader,
    Word,
    build_parchi_reader,
    WORD_GAP,
    page_tilt,
    parse_ocr_result,
    respace,
    rows,
)
from app.integrations.types import IntegrationNotConfigured
from app.main import app
from app.modules.billing import service as billing
from app.modules.parchi.parsing import parse_line, parse_lines, unglue
from app.modules.parchi.resolve import Entry, match, resolve
from app.modules.parchi.router import get_parchi_reader
from app.modules.vision.image import MAX_IMAGE_BYTES
from app.modules.vision.schemas import MatchState
from tests.conftest import create_cart, create_product

READ = "/api/v1/parchi/read"

CATALOG = {
    "Instant Noodles 35g": "7.00",
    "Instant Noodles 70g": "14.00",
    "Cola": "20.00",
    "Cola 750ml": "40.00",
    "Glucose-G Biscuits 250g": "25.00",
    "Glucose Hide & Seek": "10.00",
    "Caramel 5 Star 40g": "20.00",
    "Table Salt 1kg": "28.00",
    "Strong Teeth Paste 200g": "110.00",
}


class FakeReader:
    """Test double for the OCR boundary: returns exactly the text lines it was given."""

    name = "fake-reader"

    def __init__(self, *lines):
        self.lines = [ParchiText(line) if isinstance(line, str) else line for line in lines]

    def read(self, image: bytes):
        return self.lines


def use_reader(reader) -> None:
    app.dependency_overrides[get_parchi_reader] = lambda: reader  # cleared by make_client


def photo(fmt: str = "PNG") -> bytes:
    buf = BytesIO()
    Image.new("RGB", (64, 48), (250, 248, 240)).save(buf, format=fmt)
    return buf.getvalue()


def upload(client, data: bytes | None = None, content_type: str = "image/png"):
    return client.post(READ, files={"image": ("parchi.png", photo() if data is None else data, content_type)})


def read_lines(client, *written: str) -> list[dict]:
    use_reader(FakeReader(*written))
    res = upload(client)
    assert res.status_code == 200, res.text
    return res.json()["lines"]


def seed(client) -> dict[str, dict]:
    return {name: create_product(client, name=name, price=price, stock_quantity="50") for name, price in CATALOG.items()}


# ---- line parsing: quantities are read, never assumed ----


def readings(text: str) -> list[tuple[str | None, str]]:
    return [(None if r.quantity is None else str(r.quantity), r.description) for r in parse_line(text).readings]


@pytest.mark.parametrize(
    ("text", "quantity", "description"),
    [
        ("Noodles x2", "2", "Noodles"),
        ("Noodles x 2", "2", "Noodles"),
        ("2 x Noodles", "2", "Noodles"),
        ("2x Noodles", "2", "Noodles"),
        ("Noodles - 2", "2", "Noodles"),
        ("Noodles: 3", "3", "Noodles"),
        ("Noodles = 3 pkt", "3", "Noodles"),
        ("Noodles 2 pkt", "2", "Noodles"),
        ("2 packets Noodles", "2", "Noodles"),
        ("Glucose-G (3)", "3", "Glucose-G"),
        ("2 dozen eggs", "24", "eggs"),
        ("- Noodles x2", "2", "Noodles"),  # a bullet is not part of the item
        ("Salt 0.5 pcs", "0.5", "Salt"),
    ],
)
def test_a_marked_quantity_is_certain(text, quantity, description):
    first = parse_line(text).readings[0]
    assert (str(first.quantity), first.description, first.marked) == (quantity, description, True)


def test_a_bare_number_is_only_a_possible_quantity_and_sizes_are_never_one():
    assert readings("2 Noodles") == [("2", "Noodles"), (None, "2 Noodles")]
    assert readings("Noodles 2") == [("2", "Noodles"), (None, "Noodles 2")]
    assert readings("5 Star 2") == [("5", "Star 2"), ("2", "5 Star"), (None, "5 Star 2")]
    # A number with a size unit describes the product; without a count the quantity stays unknown.
    for text in ("Table Salt 1 kg", "Cola 750ml", "1 kg Table Salt", "Paste 200 g", "Noodles"):
        assert readings(text) == [(None, text)], text
    assert readings("2 Table Salt 1kg") == [("2", "Table Salt 1kg"), (None, "2 Table Salt 1kg")]
    assert readings("2 xylitol gum")[0] == ("2", "xylitol gum")  # "x" inside a word is not a multiplication sign
    assert readings("Noodles 0")[0] == (None, "Noodles 0") and readings("Noodles 5000")[0] == (None, "Noodles 5000")


def test_lines_that_cannot_be_items_are_dropped_and_list_numbering_is_not_a_quantity():
    assert parse_line("9810012345") is None and parse_line("250/-") is None and parse_line("  ") is None
    numbered = parse_lines(["1. Noodles 2 pkt", "2. Cola", "3) 2 Salt", "", "12/10/2026"])
    assert [(line.raw_text, readings_of(line)[0]) for line in numbered] == [
        ("1. Noodles 2 pkt", ("2", "Noodles")),
        ("2. Cola", (None, "Cola")),
        ("3) 2 Salt", ("2", "Salt")),
    ]
    # Without a 1, 2, 3 run it is unclear what "2." means: it is neither removed nor taken as a quantity.
    assert [readings_of(line) for line in parse_lines(["2. Noodles", "5. Cola"])] == [[(None, "2. Noodles")], [(None, "5. Cola")]]


def readings_of(line) -> list[tuple[str | None, str]]:
    return [(None if r.quantity is None else str(r.quantity), r.description) for r in line.readings]


# ---- catalogue matching (pure) ----

ENTRIES = [Entry(name, name) for name in CATALOG]


def matched(description: str):
    state, candidates, _ = match(description, ENTRIES)
    return state, [c.key for c in candidates]


def test_a_single_product_with_every_written_word_is_the_match():
    assert matched("glucose g") == (MatchState.MATCHED, ["Glucose-G Biscuits 250g"])
    assert matched("Glucose-G") == (MatchState.MATCHED, ["Glucose-G Biscuits 250g"])
    assert matched("hide and seek")[0] == MatchState.LOW_CONFIDENCE  # "and" is not on the pack name: confirm
    assert matched("Hide & Seek") == (MatchState.MATCHED, ["Glucose Hide & Seek"])
    assert matched("instant noodles 70g") == (MatchState.MATCHED, ["Instant Noodles 70g"])  # the size was written
    assert matched("biscuit") == (MatchState.MATCHED, ["Glucose-G Biscuits 250g"])  # singular / plural
    assert matched("COLA") == (MatchState.MATCHED, ["Cola"])  # a product's whole name wins over longer names


def test_several_fitting_products_are_offered_never_chosen():
    assert matched("noodles") == (MatchState.AMBIGUOUS, ["Instant Noodles 35g", "Instant Noodles 70g"])
    assert matched("glucose") == (MatchState.AMBIGUOUS, ["Glucose-G Biscuits 250g", "Glucose Hide & Seek"])


def test_misspelt_or_partly_matching_text_needs_confirmation():
    assert matched("strng teeth paste") == (MatchState.LOW_CONFIDENCE, ["Strong Teeth Paste 200g"])
    assert matched("teeth paste mint") == (MatchState.LOW_CONFIDENCE, ["Strong Teeth Paste 200g"])  # 2 of 3 words
    assert matched("nodles") == (MatchState.AMBIGUOUS, ["Instant Noodles 35g", "Instant Noodles 70g"])


def test_text_the_catalogue_does_not_have_is_unknown():
    assert matched("basmati rice") == (MatchState.UNMATCHED, [])
    assert matched("fresh mint chutney paste") == (MatchState.UNMATCHED, [])  # 1 word of 4 is not enough
    assert matched("250g") == (MatchState.UNMATCHED, [])  # a size alone names no product
    assert matched("") == (MatchState.UNMATCHED, []) and match("noodles", [])[0] == MatchState.UNMATCHED


def resolved(text: str):
    found = resolve(parse_line(text), ENTRIES)
    return (None if found.quantity is None else str(found.quantity), found.description, found.state)


def test_the_catalogue_decides_whether_a_bare_number_is_a_quantity_or_part_of_a_name():
    assert resolved("2 Cola") == ("2", "Cola", MatchState.MATCHED)
    assert resolved("Cola 2") == ("2", "Cola", MatchState.MATCHED)
    assert resolved("5 Star") == (None, "5 Star", MatchState.MATCHED)  # "5 Star" is the product: no quantity given
    assert resolved("5 Star 2") == ("2", "5 Star", MatchState.MATCHED)
    assert resolved("3 5 Star") == ("3", "5 Star", MatchState.MATCHED)
    assert resolved("Star 5") == ("5", "Star", MatchState.MATCHED)  # not in the name's order: a quantity
    assert resolved("5 Star x4") == ("4", "5 Star", MatchState.MATCHED)  # a marked quantity is never doubted


# ---- words read without their spaces ----


def chosen(text: str, *, take_apart: bool = True):
    found = resolve(parse_line(text), ENTRIES, take_apart=take_apart)
    return (None if found.quantity is None else str(found.quantity), found.state, [c.key for c in found.candidates])


def test_run_together_text_is_only_ever_taken_apart_never_altered():
    assert unglue("TableSalt 1kg") == "Table Salt 1 kg" and unglue("2InstantNoodles") == "2 Instant Noodles"
    assert unglue("Cola750ml") == "Cola 750 ml" and unglue("45Star") == "45 Star"
    for text in ("Table Salt 1 kg", "2 Cola", "Glucose-G", "Hide & Seek", "COLA", "Noodles x 2", ""):
        assert unglue(text) is None, text  # nothing run together: nothing to do
    for text in ("TableSalt 1kg", "2InstantNoodles", "Cola750ml", "45Star", "Glucose-G250g"):
        assert unglue(text).replace(" ", "") == text.replace(" ", "")  # only spaces were added


def test_words_read_without_their_spaces_are_matched_like_the_same_words_written_apart():
    assert chosen("TableSalt 1kg") == (None, MatchState.MATCHED, ["Table Salt 1kg"])  # "1kg" is a size: no quantity
    assert chosen("TableSalt1kg") == (None, MatchState.MATCHED, ["Table Salt 1kg"])
    assert chosen("2TableSalt") == ("2", MatchState.MATCHED, ["Table Salt 1kg"])
    assert chosen("1 TableSalt1kg") == ("1", MatchState.MATCHED, ["Table Salt 1kg"])
    assert chosen("3Glucose-G") == ("3", MatchState.MATCHED, ["Glucose-G Biscuits 250g"])
    assert chosen("2Hide&Seek") == ("2", MatchState.MATCHED, ["Glucose Hide & Seek"])
    assert chosen("Cola750ml") == (None, MatchState.MATCHED, ["Cola 750ml"])
    assert chosen("Cola2") == ("2", MatchState.MATCHED, ["Cola"])
    assert chosen("TableSalt x2") == ("2", MatchState.MATCHED, ["Table Salt 1kg"])
    # Exactly what the same words give when written with their spaces.
    for glued, apart in (("2TableSalt", "2 Table Salt"), ("TeethPaste", "Teeth Paste"), ("2StrngTeeth", "2 Strng Teeth")):
        assert chosen(glued) == chosen(apart), glued
    assert chosen("2StrngTeeth")[1] == MatchState.LOW_CONFIDENCE  # a misspelling is still only offered


def test_several_fitting_products_stay_a_choice_when_the_text_was_run_together():
    both = ["Instant Noodles 35g", "Instant Noodles 70g"]
    assert chosen("2 noodles") == ("2", MatchState.AMBIGUOUS, both)
    assert chosen("2Noodles") == ("2", MatchState.AMBIGUOUS, both)
    assert chosen("2InstantNoodles") == ("2", MatchState.AMBIGUOUS, both)
    assert chosen("InstantNoodles70g") == (None, MatchState.MATCHED, ["Instant Noodles 70g"])  # the size was written


def test_a_number_run_into_a_name_is_not_taken_as_a_quantity_when_it_may_belong_to_the_name():
    star = ["Caramel 5 Star 40g"]
    assert chosen("5Star") == (None, MatchState.MATCHED, star)  # "5 Star" is the product
    assert chosen("45Star") == (None, MatchState.LOW_CONFIDENCE, star)  # 4 x "5 Star"? "45 Star"? ask, do not count
    assert chosen("125Star") == (None, MatchState.LOW_CONFIDENCE, star)
    assert chosen("Star5") == ("5", MatchState.MATCHED, star)  # not in the name's order: a quantity, as "Star 5" is
    assert chosen("4 5Star") == ("4", MatchState.MATCHED, star)  # the quantity stood apart: it is certain


def test_taking_words_apart_never_finds_a_product_that_is_not_in_the_catalogue():
    for text in ("Bread", "Onion1kg", "2 Eggs(6)", "5Stan", "BasmatiRice", "2BasmatiRice1kg", "AmulMlk", "Cola75Dml"):
        quantity, state, candidates = chosen(text)
        assert (state, candidates) == (MatchState.UNMATCHED, []), text
    # A line that matched as it was read is never read a second way.
    assert resolve(parse_line("Glucose-G"), ENTRIES, take_apart=True).description == "Glucose-G"
    assert resolve(parse_line("2 Cola"), ENTRIES, take_apart=True).description == "Cola"
    # Only a photo is read this way: other users of the resolver (voice) are unchanged.
    assert chosen("2TableSalt", take_apart=False) == (None, MatchState.UNMATCHED, [])
    assert chosen("45Star", take_apart=False) == (None, MatchState.UNMATCHED, [])


# ---- OCR boundary ----


def test_ocr_pieces_are_grouped_into_written_lines_and_malformed_ones_skipped():
    box = lambda left, top, right, bottom: [[left, top], [right, top], [right, bottom], [left, bottom]]  # noqa: E731
    result = [
        [box(120, 20, 300, 60), "Maggi", 0.97],
        [box(40, 24, 90, 58), "2", 0.91],  # same written line, read as a separate piece
        [box(40, 100, 260, 140), "1 Coke", 0.88],
        [box(40, 180, 200, 220), "smudge", 0.2],  # too unsure to use
        None,
        "garbage",
        [box(0, 0, 10, 10), "   ", 0.9],
        [[[0, 0]], "no score"],
        [box(0, 0, 10, 10), "nan", float("nan")],
        [box(0, 5, 10, 5), "flat", 0.9],
    ]
    words = parse_ocr_result(result)
    assert [w.text for w in words] == ["Maggi", "2", "1 Coke", "smudge"]
    assert rows(words) == [ParchiText("2 Maggi", 0.91), ParchiText("1 Coke", 0.88)]
    assert rows([]) == [] and parse_ocr_result(None) == []
    assert rows([Word("a", 0, 0, 50, 40, 0.9), Word("b", 60, 30, 110, 70, 0.9)]) == [ParchiText("a", 0.9), ParchiText("b", 0.9)]


def piece(text: str, left: float, top: float, width: float, height: float, degrees: float = 0.0, score: float = 0.95):
    """One OCR piece as RapidOCR reports it: four corners, turned by `degrees` about its top-left."""
    cos, sin = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    corner = lambda x, y: [left + x * cos - y * sin, top + x * sin + y * cos]  # noqa: E731
    return [[corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)], text, score]


def tilted_parchi(degrees: float, *, quantity_x: float, name_x: float = 100, spacing: float = 120):
    """Names in one column and quantities in another, on a page photographed `degrees` off level.
    A lone digit's box comes back upright (as the real reader reports it); only its place moves."""
    slope = math.tan(math.radians(degrees))
    pieces = []
    for i, (quantity, name) in enumerate((("2", "Noodles"), ("3", "Cola 750ml"), ("4", "Table Salt"), ("1", "Paste"))):
        pieces.append(piece(name, name_x, 100 + i * spacing + name_x * slope, 300, 60, degrees))
        pieces.append(piece(quantity, quantity_x, 104 + i * spacing + quantity_x * slope, 44, 54))
    return pieces


@pytest.mark.parametrize("degrees", [0.0, 2.0, -2.0, 4.0, -4.0, 8.0])
def test_a_quantity_written_apart_stays_on_its_own_line_when_the_photo_is_tilted(degrees):
    # 800px to the right at 4 degrees is 56px lower on the photo: almost a whole line.
    right = rows(parse_ocr_result(tilted_parchi(degrees, quantity_x=900)))
    assert [r.text for r in right] == ["Noodles 2", "Cola 750ml 3", "Table Salt 4", "Paste 1"]
    left = rows(parse_ocr_result(tilted_parchi(degrees, quantity_x=20, name_x=400)))
    assert [r.text for r in left] == ["2 Noodles", "3 Cola 750ml", "4 Table Salt", "1 Paste"]
    assert page_tilt(parse_ocr_result(tilted_parchi(degrees, quantity_x=900))) == pytest.approx(math.radians(degrees))


def test_neighbouring_lines_never_merge_and_a_stray_number_is_never_given_to_an_item():
    # Lines written close together (boxes 66px apart, 60px tall), level and tilted.
    for degrees in (0.0, 4.0, -4.0):
        close = rows(parse_ocr_result(tilted_parchi(degrees, quantity_x=900, spacing=66)))
        assert [r.text for r in close] == ["Noodles 2", "Cola 750ml 3", "Table Salt 4", "Paste 1"], degrees
    # A number halfway between two lines belongs to neither: it stays alone (and is then dropped).
    between = [piece("Noodles", 100, 100, 300, 60), piece("7", 900, 164, 44, 54), piece("Cola", 100, 220, 200, 60)]
    assert [r.text for r in rows(parse_ocr_result(between))] == ["Noodles", "7", "Cola"]
    assert [readings_of(line) for line in parse_lines(["Noodles", "7", "Cola"])] == [[(None, "Noodles")], [(None, "Cola")]]
    # A number that only brushes the line above or below is not on it.
    brushing = [piece("Noodles", 100, 100, 300, 60), piece("7", 900, 135, 44, 54), piece("Cola", 100, 220, 200, 60)]
    assert [r.text for r in rows(parse_ocr_result(brushing))] == ["Noodles", "7", "Cola"]
    # A box that runs down across several lines is not part of any one of them.
    tall = [piece("Noodles", 100, 100, 300, 60), piece("21", 900, 60, 50, 210), piece("Cola", 100, 220, 200, 60)]
    assert [r.text for r in rows(parse_ocr_result(tall))] == ["Noodles", "21", "Cola"]
    # Steep "tilts" are misread boxes, not the page: they do not level anything.
    assert page_tilt(parse_ocr_result([piece("Noodles", 100, 100, 300, 60, 70.0)])) == 0.0
    assert page_tilt([]) == 0.0 and page_tilt(parse_ocr_result([piece("7", 0, 0, 44, 54, 20.0)])) == 0.0


def spelled(text: str, starts: list[float], *, top: float = 100, width: float = 30, height: float = 60, degrees: float = 0.0):
    """One OCR piece together with the reader's account of its characters: `starts[i]` is where
    character i begins along the baseline, each `width` wide. Turned by `degrees` about (100, top)."""
    cos, sin = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    corner = lambda x, y: [100 + x * cos - y * sin, top + x * sin + y * cos]  # noqa: E731
    box = lambda x0, x1: [corner(x0, 0), corner(x1, 0), corner(x1, height), corner(x0, height)]  # noqa: E731
    return [box(starts[0], starts[-1] + width), text, 0.95, [box(s, s + width) for s in starts], list(text), [0.9] * len(text)]


def read_as(entry) -> str:
    [word] = parse_ocr_result([entry])
    return word.text


@pytest.mark.parametrize("degrees", [0.0, 12.0, -12.0])
def test_a_wide_written_gap_the_reader_left_out_of_its_text_is_put_back(degrees):
    # "4   5 Star" read as "45Star": the 4 stands 100px (3.3 character widths) from the 5.
    apart = spelled("45Star", [0, 130, 195, 225, 255, 285], degrees=degrees)
    assert read_as(apart) == "4 5Star"  # 5|S is 35px (1.2 widths): not evidence of a gap, left alone
    [row] = rows(parse_ocr_result([apart]))
    assert chosen(row.text) == ("4", MatchState.MATCHED, ["Caramel 5 Star 40g"])
    # The same characters written close together: where the number ends cannot be known.
    close = spelled("45Star", [0, 44, 100, 130, 160, 190], degrees=degrees)
    assert read_as(close) == "45Star"
    assert chosen(read_as(close)) == (None, MatchState.LOW_CONFIDENCE, ["Caramel 5 Star 40g"])
    # "2   Cola" and "3   Glucose-G" the same way.
    assert read_as(spelled("2Cola", [0, 120, 150, 180, 210], degrees=degrees)) == "2 Cola"
    assert read_as(spelled("Cola3", [0, 30, 60, 90, 200], degrees=degrees)) == "Cola 3"


def test_gaps_no_wider_than_those_inside_words_never_split_a_word():
    step = lambda gaps, width=30: [sum(gaps[:i]) + i * width for i in range(len(gaps) + 1)]  # noqa: E731
    # The reader places characters roughly: inside one word it reports gaps of up to 1.45 widths.
    for gap in (0, 10, 30, 43.5, 59):  # up to just under WORD_GAP (2.0) widths
        assert read_as(spelled("Noodles", step([gap] * 6))) == "Noodles", gap
    assert WORD_GAP * 30 == 60 and read_as(spelled("Noodles", step([0, 0, 60, 0, 0, 0]))) == "Noo dles"  # at the limit
    # One odd character (a wide box, a narrow box) does not change what counts as wide.
    assert read_as(spelled("Noodles", step([0, 0, 59, 0, 0, 0]))) == "Noodles"
    # A space the reader did write is kept as it is: never doubled, never moved.
    assert read_as(spelled("2 Cola", [0, 30, 150, 180, 210, 240])) == "2 Cola"
    assert read_as(spelled("Hide& Seek", step([0, 0, 0, 45, 0, 30, 0, 0, 0]))) == "Hide& Seek"
    # Only spaces are ever added.
    for text, starts in (("45Star", [0, 130, 195, 225, 255, 285]), ("2Cola", [0, 120, 150, 180, 210]), ("TableSalt", step([70] * 8))):
        assert read_as(spelled(text, starts)).replace(" ", "") == text


def test_a_missing_or_malformed_account_of_the_characters_leaves_the_text_as_it_was_read():
    points, text, score, boxes, characters, scores = spelled("45Star", [0, 130, 195, 225, 255, 285])
    assert read_as([points, text, score, boxes, characters, scores]) == "4 5Star"
    for broken in (
        [points, text, score],  # not asked for / not given
        [points, text, score, None, None, None],
        [points, text, score, boxes, list("4SStar"), scores],  # does not spell the text
        [points, text, score, boxes[:-1], characters, scores],  # a box is missing
        [points, text, score, boxes, ["45", "S", "t", "a", "r", ""], scores],  # not one character each
        [points, text, score, [[[float("nan"), 0]] * 4] + boxes[1:], characters, scores],
        [points, text, score, [[[0, 0]]] + boxes[1:], characters, scores],
        [points, text, score, "boxes", "45Star", scores],
        [points, text, score, 7, 7, 7],
    ):
        assert read_as(broken) == "45Star", broken[3:]
    assert respace("45Star", list("45Star"), boxes, (0.0, 0.0)) == "45Star"  # no direction: nothing to measure


def test_lines_stay_separate_and_whole_when_the_reader_reports_its_characters():
    step = lambda n, start=0: [start + i * 30 for i in range(n)]  # noqa: E731
    result = [
        spelled("Noodles", step(7, 200), top=100),
        piece("2", 110, 104, 44, 54),  # the quantity of the first line, read as a piece of its own
        spelled("45Star", [0, 130, 195, 225, 255, 285], top=166),  # the next line, only 66px below
        spelled("TableSalt", step(9, 200), top=232),
        spelled("1kg", step(3, 520), top=232),
    ]
    assert [r.text for r in rows(parse_ocr_result(result))] == ["2 Noodles", "4 5Star", "TableSalt 1kg"]


def test_reader_is_selected_by_configuration_and_never_faked(monkeypatch):
    assert Settings(_env_file=None).parchi_provider == "ocr"
    with pytest.raises(ValueError):
        Settings(_env_file=None, parchi_provider="mock")
    reader = build_parchi_reader("ocr")
    assert isinstance(reader, RapidOcrParchiReader) and reader._engine is None  # loaded on first use
    assert isinstance(build_parchi_reader("none"), NotConfiguredParchiReader)
    monkeypatch.setattr(settings, "parchi_provider", "none")
    assert isinstance(get_parchi_reader(), NotConfiguredParchiReader)


def test_missing_ocr_engine_fails_clearly(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_ocr(name, *args, **kwargs):
        if name.startswith("rapidocr"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_ocr)
    with pytest.raises(IntegrationNotConfigured, match="uv sync --extra parchi"):
        RapidOcrParchiReader().read(photo())


# ---- API: upload validation and errors ----


def test_requires_login_and_a_valid_image(client_a, make_client):
    use_reader(FakeReader("2 Cola"))
    assert upload(make_client()).status_code == 401
    assert client_a.post(READ).status_code == 422
    for data, content_type in ((b"not an image", "image/png"), (photo(), "text/plain"), (b"", "image/png")):
        res = upload(client_a, data, content_type)
        assert res.status_code == 422 and res.json()["error"]["code"] == "invalid_image"
    big = upload(client_a, b"\x89PNG" + b"0" * MAX_IMAGE_BYTES)
    assert big.status_code == 413 and big.json()["error"]["code"] == "image_too_large"
    for fmt, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
        assert upload(client_a, photo(fmt), mime).status_code == 200


def test_switched_off_or_failing_reader_is_a_clean_error(client_a, monkeypatch):
    monkeypatch.setattr(settings, "parchi_provider", "none")
    res = upload(client_a)
    assert res.status_code == 503 and res.json()["error"]["code"] == "parchi_unavailable"
    assert "PARCHI_PROVIDER=none" in res.json()["error"]["message"]

    class Broken:
        name = "broken"

        def read(self, image):
            raise RuntimeError("onnxruntime exploded")

    use_reader(Broken())
    res = upload(client_a)
    assert res.status_code == 502 and res.json()["error"]["code"] == "parchi_failed"
    assert "onnxruntime" not in res.json()["error"]["message"]  # internals are not leaked to the browser


def test_malformed_reader_output_never_becomes_items(client_a):
    seed(client_a)

    class Malformed:
        name = "malformed"

        def __init__(self, output):
            self.output = output

        def read(self, image):
            return self.output

    use_reader(Malformed("2 Cola"))  # not a list of lines
    assert upload(client_a).status_code == 502
    use_reader(
        Malformed([None, 42, ParchiText(""), ParchiText("   "), ParchiText(7), ParchiText("2 Cola", float("nan")), {"text": "x"}])
    )
    body = upload(client_a).json()
    assert [(line["raw_text"], line["read_confidence"]) for line in body["lines"]] == [("2 Cola", None)]
    use_reader(FakeReader())
    assert upload(client_a).json() == {"provider": "fake-reader", "text": "", "lines": []}  # nothing read, nothing invented


# ---- API: extraction and catalogue matching ----


def test_reads_several_lines_with_quantities_names_and_catalogue_prices(client_a):
    catalog = seed(client_a)
    use_reader(FakeReader(ParchiText("2 Cola", 0.93), ParchiText("3 Glucose-G", 0.81), ParchiText("Table Salt 1 kg x2", 0.9)))
    body = upload(client_a).json()
    assert body["provider"] == "fake-reader" and body["text"] == "2 Cola\n3 Glucose-G\nTable Salt 1 kg x2"

    cola, biscuits, salt = body["lines"]
    assert [line["id"] for line in body["lines"]] == ["l0", "l1", "l2"]
    assert (cola["raw_text"], cola["description"], cola["quantity"], cola["read_confidence"]) == ("2 Cola", "Cola", "2.000", 0.93)
    assert cola["match"] == "matched" and cola["candidates"] == []
    assert cola["product"]["id"] == catalog["Cola"]["id"] and cola["product"]["price"] == "20.00"  # the catalogue's price
    assert (cola["match_confidence"], cola["matched_words"], cola["unmatched_words"]) == (1.0, ["cola"], [])
    assert (biscuits["quantity"], biscuits["product"]["name"]) == ("3.000", "Glucose-G Biscuits 250g")
    assert (salt["quantity"], salt["product"]["name"], salt["product"]["price"]) == ("2.000", "Table Salt 1kg", "28.00")


def test_a_line_without_a_reliable_quantity_asks_for_it_instead_of_assuming_one(client_a):
    seed(client_a)
    cola, star, numbered = read_lines(client_a, "Cola", "5 Star", "Table Salt 1 kg")
    assert cola["match"] == "matched" and cola["quantity"] is None
    assert star["product"]["name"] == "Caramel 5 Star 40g" and star["quantity"] is None  # "5" is its name, not a count
    assert numbered["product"]["name"] == "Table Salt 1kg" and numbered["quantity"] is None  # "1 kg" is a size


def test_ambiguous_lines_offer_this_merchants_candidates(client_a):
    catalog = seed(client_a)
    [noodles] = read_lines(client_a, "2 noodles")
    assert noodles["match"] == "ambiguous" and noodles["product"] is None and noodles["quantity"] == "2.000"
    assert [c["id"] for c in noodles["candidates"]] == [catalog["Instant Noodles 35g"]["id"], catalog["Instant Noodles 70g"]["id"]]
    assert [c["price"] for c in noodles["candidates"]] == ["7.00", "14.00"]

    [misspelt] = read_lines(client_a, "1 strng teeth paste")
    assert misspelt["match"] == "low_confidence" and misspelt["product"] is None
    assert [c["name"] for c in misspelt["candidates"]] == ["Strong Teeth Paste 200g"]


def test_unknown_products_are_not_found_never_guessed(client_a):
    seed(client_a)
    rice, header = read_lines(client_a, "2 kg basmati rice", "Sharma ji ka saman")
    for line in (rice, header):
        assert line["match"] == "unmatched" and line["product"] is None and line["candidates"] == []
        assert line["match_confidence"] is None and line["matched_words"] == []
    assert rice["unmatched_words"] == ["2kg", "basmati", "rice"]


def test_lines_read_without_spaces_keep_what_was_read_and_are_matched_or_left_for_the_merchant(client_a):
    seed(client_a)
    salt, noodles, star, onion = read_lines(client_a, "2TableSalt 1kg", "2InstantNoodles", "45Star", "Onion1kg")
    assert salt["raw_text"] == "2TableSalt 1kg"  # shown exactly as it was read
    assert (salt["match"], salt["product"]["name"], salt["quantity"]) == ("matched", "Table Salt 1kg", "2.000")
    assert (salt["matched_words"], salt["unmatched_words"]) == (["table", "salt", "1kg"], [])
    assert (noodles["match"], noodles["product"], noodles["quantity"]) == ("ambiguous", None, "2.000")
    assert [c["name"] for c in noodles["candidates"]] == ["Instant Noodles 35g", "Instant Noodles 70g"]
    assert (star["match"], star["product"], star["quantity"]) == ("low_confidence", None, None)  # nothing preselected
    assert [c["name"] for c in star["candidates"]] == ["Caramel 5 Star 40g"]
    assert (onion["match"], onion["product"], onion["candidates"], onion["quantity"]) == ("unmatched", None, [], None)


def test_inactive_products_are_never_offered(client_a):
    catalog = seed(client_a)
    client_a.delete(f"/api/v1/products/{catalog['Cola']['id']}")
    [cola] = read_lines(client_a, "2 Cola")
    assert cola["match"] == "matched" and cola["product"]["name"] == "Cola 750ml"  # the only active cola left


def test_matching_only_sees_the_authenticated_merchants_catalogue(client_a, client_b):
    a_catalog = seed(client_a)
    b_cola = create_product(client_b, name="Cola 2L", price="95.00")
    create_product(client_b, name="Basmati Rice 1kg", price="150.00")  # only Store B sells rice

    written = ("2 Cola", "1 basmati rice", "3 noodles")
    a_cola, a_rice, a_noodles = read_lines(client_a, *written)
    assert a_cola["product"]["id"] == a_catalog["Cola"]["id"] and a_cola["product"]["price"] == "20.00"
    assert a_rice["match"] == "unmatched" and a_rice["candidates"] == []  # Store B's rice is invisible to Store A
    a_ids = {p["id"] for p in a_catalog.values()}
    assert {c["id"] for c in a_noodles["candidates"]} <= a_ids

    b_cola_line, b_rice, b_noodles = read_lines(client_b, *written)
    assert b_cola_line["product"]["id"] == b_cola["id"] and b_cola_line["product"]["price"] == "95.00"
    assert b_rice["match"] == "matched" and b_rice["product"]["price"] == "150.00"
    assert b_noodles["match"] == "unmatched"  # Store A's noodles are invisible to Store B
    returned = [b_cola_line["product"], b_rice["product"], *b_noodles["candidates"]]
    assert all(p["id"] not in a_ids for p in returned)


# ---- reading is read-only; confirmed lines use the existing billing path ----


def test_reading_a_parchi_never_touches_a_cart_or_stock(client_a):
    catalog = seed(client_a)
    cart = create_cart(client_a)
    for _ in range(3):
        assert read_lines(client_a, "2 Cola", "3 Glucose-G")[0]["match"] == "matched"
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["items"] == []
    assert client_a.get(f"/api/v1/products/{catalog['Cola']['id']}").json()["stock_quantity"] == "50.000"


def test_confirmed_lines_enter_the_existing_cart_through_add_item_and_checkout(client_a, monkeypatch):
    catalog = seed(client_a)
    cola, biscuits, noodles = read_lines(client_a, "2 Cola", "3 Glucose-G", "1 noodles")
    cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": catalog["Table Salt 1kg"]["id"]})  # manual first

    calls = []
    original = billing.add_item
    monkeypatch.setattr(billing, "add_item", lambda *a, **k: calls.append(a[3:]) or original(*a, **k))
    chosen = noodles["candidates"][1]  # the merchant picks the 70g pack
    res = client_a.post(
        f"/api/v1/carts/{cart['id']}/recognized-items",
        json={
            "source": "parchi",
            "items": [
                {"product_id": cola["product"]["id"], "quantity": cola["quantity"]},
                {"product_id": biscuits["product"]["id"], "quantity": "4"},  # edited by the merchant
                {"product_id": chosen["id"], "quantity": noodles["quantity"]},
            ],
        },
    )
    assert res.status_code == 200, res.text
    assert [(str(pid), qty, source) for pid, qty, source in calls] == [
        (catalog["Cola"]["id"], Decimal(2), InputSource.PARCHI),
        (catalog["Glucose-G Biscuits 250g"]["id"], Decimal(4), InputSource.PARCHI),
        (catalog["Instant Noodles 70g"]["id"], Decimal(1), InputSource.PARCHI),
    ]
    body = res.json()
    assert body["id"] == cart["id"] and body["subtotal"] == "182.00"  # 28 + 2x20 + 4x25 + 14: one bill
    assert [(i["product_name"], i["source"]) for i in body["items"]] == [
        ("Table Salt 1kg", "manual"),
        ("Cola", "parchi"),
        ("Glucose-G Biscuits 250g", "parchi"),
        ("Instant Noodles 70g", "parchi"),
    ]

    order = client_a.post(f"/api/v1/carts/{cart['id']}/checkout", json={"method": "cash"})
    assert order.status_code == 201 and order.json()["total"] == "182.00"  # the normal checkout, unchanged
    assert client_a.get(f"/api/v1/products/{catalog['Cola']['id']}").json()["stock_quantity"] == "48.000"


def test_cannot_confirm_another_merchants_product_from_a_parchi(client_a, client_b):
    seed(client_a)
    theirs = create_product(client_b, name="Basmati Rice 1kg")
    cart = create_cart(client_a)
    res = client_a.post(
        f"/api/v1/carts/{cart['id']}/recognized-items",
        json={"source": "parchi", "items": [{"product_id": theirs["id"], "quantity": "1"}]},
    )
    assert res.status_code == 404
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["items"] == []


# ---- opt-in: the real OCR engine ----

SMOKE = os.environ.get("PARCHI_REAL_SMOKE") == "1"


@pytest.mark.skipif(not SMOKE, reason="set PARCHI_REAL_SMOKE=1 (and `uv sync --extra parchi`) to run the real OCR engine")
def test_smoke_real_ocr_reads_a_printed_parchi_end_to_end(client_a):
    pytest.importorskip("rapidocr_onnxruntime")
    from PIL import ImageDraw, ImageFont

    catalog = seed(client_a)
    image = Image.new("RGB", (900, 420), (250, 248, 240))
    draw = ImageDraw.Draw(image)
    for i, text in enumerate(("2 Cola", "3 Glucose-G", "Table Salt 1 kg")):
        draw.text((70, 50 + 110 * i), text, fill=(25, 30, 90), font=ImageFont.load_default(size=60))
    data = BytesIO()
    image.save(data, "JPEG", quality=85)

    use_reader(RapidOcrParchiReader())
    res = upload(client_a, data.getvalue(), "image/jpeg")
    assert res.status_code == 200, res.text
    found = [(line["quantity"], line["product"] and line["product"]["id"]) for line in res.json()["lines"]]
    assert found == [
        ("2.000", catalog["Cola"]["id"]),
        ("3.000", catalog["Glucose-G Biscuits 250g"]["id"]),
        (None, catalog["Table Salt 1kg"]["id"]),
    ]


@pytest.mark.skipif(not SMOKE, reason="set PARCHI_REAL_SMOKE=1 (and `uv sync --extra parchi`) to run the real OCR engine")
@pytest.mark.parametrize("degrees", [0, 3, -3, 5])
@pytest.mark.parametrize("quantity_x", [60, 640])
def test_smoke_real_ocr_keeps_quantities_written_in_their_own_column_on_a_tilted_photo(client_a, degrees, quantity_x):
    pytest.importorskip("rapidocr_onnxruntime")
    from PIL import ImageDraw, ImageFont

    catalog = seed(client_a)
    paper = (250, 248, 240)
    image = Image.new("RGB", (900, 620), paper)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=56)
    for i, (quantity, text) in enumerate((("2", "Cola"), ("3", "Glucose-G"), ("4", "Table Salt"), ("5", "Noodles 70g"))):
        draw.text((60 if quantity_x > 300 else 200, 60 + 130 * i), text, fill=(25, 30, 90), font=font)
        draw.text((quantity_x, 60 + 130 * i), quantity, fill=(25, 30, 90), font=font)
    data = BytesIO()
    image.rotate(degrees, resample=Image.BICUBIC, expand=True, fillcolor=paper).save(data, "JPEG", quality=85)

    use_reader(RapidOcrParchiReader())
    res = upload(client_a, data.getvalue(), "image/jpeg")
    assert res.status_code == 200, res.text
    found = [(line["quantity"], line["product"] and line["product"]["id"]) for line in res.json()["lines"]]
    assert found == [
        ("2.000", catalog["Cola"]["id"]),
        ("3.000", catalog["Glucose-G Biscuits 250g"]["id"]),
        ("4.000", catalog["Table Salt 1kg"]["id"]),
        ("5.000", catalog["Instant Noodles 70g"]["id"]),
    ], res.json()["text"]


@pytest.mark.skipif(not SMOKE, reason="set PARCHI_REAL_SMOKE=1 (and `uv sync --extra parchi`) to run the real OCR engine")
@pytest.mark.parametrize("gap", [60, 110, 170])  # px between the quantity and the item: about 2, 3.5 and 5.5 characters
def test_smoke_real_ocr_a_quantity_written_apart_from_a_name_that_starts_with_a_number(client_a, gap):
    pytest.importorskip("rapidocr_onnxruntime")
    from PIL import ImageDraw, ImageFont

    catalog = seed(client_a)
    image = Image.new("RGB", (900, 440), (250, 248, 240))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=56)
    for i, (quantity, text) in enumerate((("4", "5 Star"), ("2", "Cola"), ("3", "Glucose-G"))):
        draw.text((70, 50 + 120 * i), quantity, fill=(25, 30, 90), font=font)
        draw.text((70 + draw.textlength(quantity, font=font) + gap, 50 + 120 * i), text, fill=(25, 30, 90), font=font)
    data = BytesIO()
    image.save(data, "JPEG", quality=85)

    use_reader(RapidOcrParchiReader())
    res = upload(client_a, data.getvalue(), "image/jpeg")
    assert res.status_code == 200, res.text
    found = [(line["quantity"], line["product"] and line["product"]["id"]) for line in res.json()["lines"]]
    assert found == [
        ("4.000", catalog["Caramel 5 Star 40g"]["id"]),
        ("2.000", catalog["Cola"]["id"]),
        ("3.000", catalog["Glucose-G Biscuits 250g"]["id"]),
    ], res.json()["text"]


@pytest.mark.skipif(not SMOKE, reason="set PARCHI_REAL_SMOKE=1 (and `uv sync --extra parchi`) to run the real OCR engine")
def test_smoke_real_ocr_lines_written_without_gaps_are_matched_or_left_for_the_merchant(client_a):
    pytest.importorskip("rapidocr_onnxruntime")
    from PIL import ImageDraw, ImageFont

    catalog = seed(client_a)
    image = Image.new("RGB", (900, 560), (250, 248, 240))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=56)
    for i, text in enumerate(("2TableSalt", "3ColaZero", "TeethPaste", "Bread")):  # no gaps at all: read as written here
        draw.text((70, 50 + 120 * i), text, fill=(25, 30, 90), font=font)
    data = BytesIO()
    image.save(data, "JPEG", quality=85)

    use_reader(RapidOcrParchiReader())
    res = upload(client_a, data.getvalue(), "image/jpeg")
    assert res.status_code == 200, res.text
    salt, cola, paste, bread = res.json()["lines"]
    assert [line["raw_text"] for line in (salt, cola, paste, bread)] == ["2TableSalt", "3ColaZero", "TeethPaste", "Bread"]
    assert (salt["quantity"], salt["product"]["id"]) == ("2.000", catalog["Table Salt 1kg"]["id"])
    assert (paste["quantity"], paste["product"]["id"]) == (None, catalog["Strong Teeth Paste 200g"]["id"])
    assert (cola["match"], cola["product"], cola["quantity"]) == ("ambiguous", None, "3.000")  # which cola? never preselected
    assert [c["name"] for c in cola["candidates"]] == ["Cola", "Cola 750ml"]
    assert (bread["match"], bread["product"], bread["candidates"]) == ("unmatched", None, [])
