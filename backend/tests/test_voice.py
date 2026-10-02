"""Voice -> Bill: a speech-to-text transcript split into items, quantities, merchant-scoped
catalogue matching, and confirmed items entering the existing cart through the existing
recognized-items path.

Speech-to-text runs in the browser, so these tests start from its output: a transcript.
Quantities and catalogue matches are always decided by the code under test.
"""

import pytest

from app.core.enums import InputSource
from app.modules.voice.parsing import split_items
from app.modules.voice.schemas import MAX_TRANSCRIPT_CHARS
from tests.conftest import create_cart, create_product

PARSE = "/api/v1/voice/parse"

CATALOG = {
    "Instant Noodles 35g": "7.00",
    "Instant Noodles 70g": "14.00",
    "Zesty 2-Minute Soup": "12.00",
    "Cola": "20.00",
    "Cola 750ml": "40.00",
    "Glucose-G Biscuits 250g": "25.00",
    "Glucose Hide & Seek": "10.00",
    "Caramel 5 Star 40g": "20.00",
    "Table Salt 1kg": "28.00",
    "Strong Teeth Paste 200g": "110.00",
}
NAMES = list(CATALOG)


def seed(client) -> dict[str, dict]:
    return {name: create_product(client, name=name, price=price, stock_quantity="50") for name, price in CATALOG.items()}


def say(client, transcript: str) -> list[dict]:
    res = client.post(PARSE, json={"transcript": transcript})
    assert res.status_code == 200, res.text
    return res.json()["lines"]


def heard(lines: list[dict]) -> list[tuple]:
    return [(line["quantity"], line["description"], line["match"]) for line in lines]


# ---- splitting a transcript into items (pure) ----


@pytest.mark.parametrize(
    ("transcript", "items"),
    [
        ("2 cola", ["2 cola"]),  # numeric quantity
        ("two cola", ["2 cola"]),  # number word
        ("add ten cola please", ["10 cola"]),
        ("Add two noodles, one cola, three glucose g and one crisps", ["2 noodles", "1 cola", "3 glucose g", "1 crisps"]),
        # Speech-to-text usually gives no punctuation: the next quantity starts the next item.
        ("add 2 noodles 1 cola 3 glucose G and 1 crisps", ["2 noodles", "1 cola", "3 glucose G", "1 crisps"]),
        ("cola two noodles three", ["cola 2", "noodles 3"]),  # quantity said after the product
        ("cola 2 noodles 3 salt", ["cola 2", "noodles 3", "salt"]),
        ("add cola", ["cola"]),  # no quantity said
        ("cola and salt", ["cola", "salt"]),
        ("two packets of crisps", ["2 packets crisps"]),
        ("crisps two packets cola one", ["crisps 2 packets", "cola 1"]),
        ("add one dozen eggs to the bill.", ["1 dozen eggs"]),
        ("2 3", []),
        ("", []),
    ],
)
def test_a_transcript_is_split_where_quantities_are_said(transcript, items):
    assert split_items(transcript, NAMES) == items


def test_numbers_inside_a_catalogue_name_are_not_quantities():
    assert split_items("5 star two", NAMES) == ["5 star 2"]
    assert split_items("five star", NAMES) == ["5 star"]
    assert split_items("three five star one cola", NAMES) == ["3 5 star", "1 cola"]
    assert split_items("zesty two minute soup", NAMES) == ["zesty 2 minute soup"]
    assert split_items("two zesty 2 minute soup one cola", NAMES) == ["2 zesty 2 minute soup", "1 cola"]
    # A size is part of the product, not a count.
    assert split_items("one cola 750 ml two table salt one kg", NAMES) == ["1 cola 750 ml", "2 table salt 1 kg"]
    # "and" inside a product's name does not end the item.
    assert split_items("one hide and seek and two cola", NAMES) == ["1 hide seek", "2 cola"]


def test_the_parser_knows_no_products_only_the_catalogue_it_is_given():
    # Invented names behave exactly like real ones: the same sentence is read from whichever catalogue is passed.
    assert split_items("9 lives two", ["Zorbo 9 Lives"]) == ["9 lives 2"]
    assert split_items("9 lives two", ["Zorbo Lives"]) == ["9 lives"]  # without that name, 9 is the quantity
    assert split_items("two blip and blop", ["Blip & Blop Wafers"]) == ["2 blip blop"]
    assert split_items("two blip and blop", []) == ["2 blip", "blop"]
    assert split_items("5 star two") == ["5 star"]  # no catalogue, no special case for any product


# ---- API ----


def test_requires_login_and_a_transcript(client_a, make_client):
    assert make_client().post(PARSE, json={"transcript": "two cola"}).status_code == 401
    assert client_a.post(PARSE, json={}).status_code == 422
    assert client_a.post(PARSE, json={"transcript": ""}).status_code == 422
    assert client_a.post(PARSE, json={"transcript": "x" * (MAX_TRANSCRIPT_CHARS + 1)}).status_code == 422
    assert client_a.post(PARSE, json={"transcript": "   "}).json() == {"transcript": "", "lines": []}  # nothing invented


def test_several_products_in_one_sentence_with_catalogue_names_and_prices(client_a):
    catalog = seed(client_a)
    res = client_a.post(PARSE, json={"transcript": "Add two cola,  3 glucose g and one table salt"})
    body = res.json()
    assert body["transcript"] == "Add two cola, 3 glucose g and one table salt"

    cola, biscuits, salt = body["lines"]
    assert [line["id"] for line in body["lines"]] == ["v0", "v1", "v2"]
    assert (cola["raw_text"], cola["description"], cola["quantity"]) == ("2 cola", "cola", "2.000")
    assert cola["match"] == "matched" and cola["candidates"] == []
    assert cola["product"]["id"] == catalog["Cola"]["id"] and cola["product"]["price"] == "20.00"  # the catalogue's price
    assert (cola["match_confidence"], cola["matched_words"], cola["unmatched_words"]) == (1.0, ["cola"], [])
    assert (biscuits["quantity"], biscuits["product"]["name"]) == ("3.000", "Glucose-G Biscuits 250g")
    assert (salt["quantity"], salt["product"]["name"], salt["product"]["price"]) == ("1.000", "Table Salt 1kg", "28.00")


def test_a_missing_quantity_is_asked_for_never_assumed(client_a):
    seed(client_a)
    assert heard(say(client_a, "add cola")) == [(None, "cola", "matched")]
    assert heard(say(client_a, "cola and table salt")) == [(None, "cola", "matched"), (None, "table salt", "matched")]


def test_product_names_containing_numbers(client_a):
    seed(client_a)
    assert heard(say(client_a, "5 star two")) == [("2.000", "5 star", "matched")]
    assert heard(say(client_a, "five star")) == [(None, "5 star", "matched")]  # "5" is its name, not a count
    assert heard(say(client_a, "three 5 star")) == [("3.000", "5 star", "matched")]
    soup = say(client_a, "zesty 2 minute soup")
    assert heard(soup) == [(None, "zesty 2 minute soup", "matched")] and soup[0]["product"]["name"] == "Zesty 2-Minute Soup"
    assert heard(say(client_a, "four zesty two minute soup")) == [("4.000", "zesty 2 minute soup", "matched")]


def test_ambiguous_unsure_and_unknown_items_are_left_to_the_merchant(client_a):
    catalog = seed(client_a)
    noodles, paste, crisps = say(client_a, "two noodles one strng teeth paste two packets of crisps")
    # Several catalogue products fit: offered, never chosen.
    assert (noodles["match"], noodles["product"], noodles["quantity"]) == ("ambiguous", None, "2.000")
    assert [c["name"] for c in noodles["candidates"]] == ["Instant Noodles 35g", "Instant Noodles 70g"]
    # A near miss is a suggestion, not a match.
    assert (paste["match"], paste["product"]) == ("low_confidence", None)
    assert [c["id"] for c in paste["candidates"]] == [catalog["Strong Teeth Paste 200g"]["id"]]
    # Not in the catalogue: no product and no price are invented.
    assert (crisps["match"], crisps["product"], crisps["candidates"], crisps["quantity"]) == ("unmatched", None, [], "2.000")
    assert crisps["match_confidence"] is None and crisps["unmatched_words"] == ["crisps"]


def test_only_the_logged_in_merchants_catalogue_is_used(client_a, client_b):
    mine = create_product(client_a, name="Cola", price="20.00")
    create_product(client_a, name="Caramel 5 Star 40g", price="20.00")
    theirs = create_product(client_b, name="Cola", price="99.00")
    create_product(client_b, name="Orange Squash", price="60.00")

    cola, squash = say(client_a, "two cola one orange squash")
    assert cola["product"]["id"] == mine["id"] and cola["product"]["price"] == "20.00"
    assert (squash["match"], squash["candidates"]) == ("unmatched", [])  # exists only in the other store

    cola, star = say(client_b, "two cola five star")
    assert cola["product"]["id"] == theirs["id"] and cola["product"]["price"] == "99.00"
    # Store B has no "5 Star", so there the 5 is not protected as a name and nothing of store A's is offered.
    assert (star["match"], star["candidates"]) == ("unmatched", [])


def test_parsing_never_touches_a_cart_and_confirmed_items_use_the_existing_cart_path(client_a):
    catalog = seed(client_a)
    cart = create_cart(client_a)
    lines = say(client_a, "two cola three glucose g")
    assert client_a.get(f"/api/v1/carts/{cart['id']}").json()["items"] == []  # read-only until confirmed

    items = [{"product_id": line["product"]["id"], "quantity": line["quantity"]} for line in lines]
    res = client_a.post(f"/api/v1/carts/{cart['id']}/recognized-items", json={"source": "voice", "items": items})
    assert res.status_code == 200, res.text
    added = res.json()["items"]
    assert [(i["product_name"], i["quantity"], i["unit_price"], i["source"]) for i in added] == [
        ("Cola", "2.000", "20.00", InputSource.VOICE),
        ("Glucose-G Biscuits 250g", "3.000", "25.00", InputSource.VOICE),
    ]
    assert res.json()["subtotal"] == "115.00"

    # A manual addition of the same product joins the same line of the same cart.
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": catalog["Cola"]["id"], "quantity": "1"})
    cart_now = client_a.get(f"/api/v1/carts/{cart['id']}").json()
    assert len(cart_now["items"]) == 2 and cart_now["subtotal"] == "135.00"
