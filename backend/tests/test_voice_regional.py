"""Voice -> Bill in Tamil, Bengali, Telugu, Marathi, Malayalam, Kannada and Gujarati.

These are *parser* tests: they start from a typed transcript, as the browser's recogniser for
that language would hand it over, and check the items, quantities, commands and catalogue
matches. Whether a recogniser actually produces such transcripts from speech is not tested here.
"""

import pytest

from app.modules.voice.language import command, plain, sound, transliterate
from app.modules.voice.parsing import split_items
from tests.conftest import create_cart, create_product

PARSE = "/api/v1/voice/parse"

CATALOG = {
    "Instant Noodles 35g": "7.00",
    "Instant Noodles 70g": "14.00",
    "Cola": "20.00",
    "Cola 750ml": "40.00",
    "Glucose-G Biscuits 250g": "25.00",
    "Caramel 5 Star 40g": "20.00",
    "Table Salt 1kg": "28.00",
}
NAMES = list(CATALOG)


def seed(client) -> dict[str, dict]:
    return {name: create_product(client, name=name, price=price, stock_quantity="50") for name, price in CATALOG.items()}


def ask(client, transcript: str, cart: dict | None = None) -> dict:
    res = client.post(PARSE, json={"transcript": transcript, "cart_id": cart and cart["id"]})
    assert res.status_code == 200, res.text
    return res.json()


def offered(line: dict) -> list[str]:
    return [line["product"]["name"]] if line["product"] else [c["name"] for c in line["candidates"]]


# One set of sentences per language: add two things, add one more, remove, change, total, clear.
ADD = {
    "tamil": "பில்லில் இரண்டு நூடுல்ஸ் மற்றும் ஒரு கோலா 750 எம்எல் சேர்க்கவும்",
    "bengali": "বিলে দুটো নুডলস আর একটা কোলা 750 এমএল যোগ করো",
    "telugu": "బిల్లులో రెండు నూడుల్స్ మరియు ఒక కోలా 750 ఎంఎల్ చేర్చండి",
    "marathi": "बिलात दोन नूडल्स आणि एक कोला 750 एमएल जोडा",
    "malayalam": "ബില്ലിൽ രണ്ട് നൂഡിൽസ് പിന്നെ ഒരു കോള 750 എംഎൽ ചേർക്കുക",
    "kannada": "ಬಿಲ್‌ಗೆ ಎರಡು ನೂಡಲ್ಸ್ ಮತ್ತು ಒಂದು ಕೋಲಾ 750 ಎಂಎಲ್ ಸೇರಿಸಿ",
    "gujarati": "બિલમાં બે નૂડલ્સ અને એક કોલા 750 એમએલ ઉમેરો",
}
ADD_MORE = {
    "tamil": "மூன்று குளுக்கோஸ் ஜி சேர்",
    "bengali": "তিনটে গ্লুকোজ জি যোগ করো",
    "telugu": "మూడు గ్లూకోజ్ జీ చేర్చండి",
    "marathi": "तीन ग्लुकोज जी जोडा",
    "malayalam": "മൂന്ന് ഗ്ലൂക്കോസ് ജി ചേർക്കൂ",
    "kannada": "ಮೂರು ಗ್ಲೂಕೋಸ್ ಜಿ ಸೇರಿಸಿ",
    "gujarati": "ત્રણ ગ્લુકોઝ જી ઉમેરો",
}
REMOVE = {
    "tamil": "கோலாவை பில்லிலிருந்து நீக்கு",
    "bengali": "কোলা বিল থেকে সরাও",
    "telugu": "కోలా బిల్లు నుండి తీసివేయండి",
    "marathi": "कोला बिलातून काढा",
    "malayalam": "കോള ബില്ലിൽ നിന്ന് നീക്കം ചെയ്യുക",
    "kannada": "ಕೋಲಾ ಬಿಲ್‌ನಿಂದ ತೆಗೆದುಹಾಕಿ",
    "gujarati": "કોલા બિલમાંથી કાઢો",
}
CHANGE = {
    "tamil": "நூடுல்ஸ் அளவை நான்கு ஆக மாற்று",
    "bengali": "নুডলসের পরিমাণ চার করো",
    "telugu": "నూడుల్స్ పరిమాణం నాలుగు చేయండి",
    "marathi": "नूडल्सची संख्या चार करा",
    "malayalam": "നൂഡിൽസ് അളവ് നാല് ആക്കുക",
    "kannada": "ನೂಡಲ್ಸ್ ಪ್ರಮಾಣ ನಾಲ್ಕು ಮಾಡಿ",
    "gujarati": "નૂડલ્સની સંખ્યા ચાર કરો",
}
TOTAL = {
    "tamil": "மொத்தம் எவ்வளவு?", "bengali": "মোট কত হলো?", "telugu": "మొత్తం ఎంత?", "marathi": "एकूण किती झाले?",
    "malayalam": "ആകെ എത്രയായി?", "kannada": "ಒಟ್ಟು ಎಷ್ಟು?", "gujarati": "કુલ કેટલા થયા?",
}  # fmt: skip
CLEAR = {
    "tamil": "பில்லை அழிக்கவும்", "bengali": "বিল খালি করো", "telugu": "బిల్లు క్లియర్ చేయండి", "marathi": "बिल रिकामे करा",
    "malayalam": "ബിൽ ക്ലിയർ ചെയ്യുക", "kannada": "ಬಿಲ್ ಕ್ಲಿಯರ್ ಮಾಡಿ", "gujarati": "બિલ ખાલી કરો",
}  # fmt: skip
LANGUAGES = list(ADD)


# ---- the sentence: numbers, "and", and the words that are not items ----


@pytest.mark.parametrize(
    ("transcript", "items"),
    [
        (ADD["tamil"], ["2 நூடுல்ஸ்", "1 கோலா 750 ml"]),
        (ADD["bengali"], ["2 নুডলস", "1 কোলা 750 ml"]),
        (ADD["telugu"], ["2 నూడుల్స్", "1 కోలా 750 ml"]),
        (ADD["marathi"], ["2 नूडल्स", "1 कोला 750 ml"]),
        (ADD_MORE["tamil"], ["3 குளுக்கோஸ் ஜி"]),
        (ADD_MORE["bengali"], ["3 গ্লুকোজ জি"]),
        (ADD_MORE["telugu"], ["3 గ్లూకోజ్ జీ"]),
        (ADD_MORE["marathi"], ["3 ग्लुकोज जी"]),
        (ADD["malayalam"], ["2 നൂഡിൽസ്", "1 കോള 750 ml"]),
        (ADD["kannada"], ["2 ನೂಡಲ್ಸ್", "1 ಕೋಲಾ 750 ml"]),
        (ADD["gujarati"], ["2 નૂડલ્સ", "1 કોલા 750 ml"]),
        (ADD_MORE["malayalam"], ["3 ഗ്ലൂക്കോസ് ജി"]),
        (ADD_MORE["kannada"], ["3 ಗ್ಲೂಕೋಸ್ ಜಿ"]),
        (ADD_MORE["gujarati"], ["3 ગ્લુકોઝ જી"]),
        ("കോള മൂന്ന്", ["കോള 3"]),
        ("ಕೋಲಾ ಮೂರು", ["ಕೋಲಾ 3"]),
        ("કોલા ત્રણ", ["કોલા 3"]),
        ("൨ കോള", ["2 കോള"]),
        ("೨ ಕೋಲಾ ಮತ್ತು ೩ ನೂಡಲ್ಸ್", ["2 ಕೋಲಾ", "3 ನೂಡಲ್ಸ್"]),
        ("૨ કોલા અને ૩ નૂડલ્સ", ["2 કોલા", "3 નૂડલ્સ"]),
        ("ഒരു കിലോ ഉപ്പ്", ["1 kg ഉപ്പ്"]),
        ("ಒಂದು ಕಿಲೋ ಉಪ್ಪು", ["1 kg ಉಪ್ಪು"]),
        ("એક કિલો મીઠું", ["1 kg મીઠું"]),
        ("അഞ്ച് പാക്കറ്റ് നൂഡിൽസ്", ["5 packet നൂഡിൽസ്"]),
        ("ಐದು ಪ್ಯಾಕೆಟ್ ನೂಡಲ್ಸ್", ["5 packet ನೂಡಲ್ಸ್"]),
        ("પાંચ પેકેટ નૂડલ્સ", ["5 packet નૂડલ્સ"]),
        ("randu cola pinne oru noodles venam", ["2 cola", "1 noodles"]),
        ("eradu cola mattu ondu noodles kodi", ["2 cola", "1 noodles"]),
        ("tran cola ane ek noodles aapo", ["3 cola", "1 noodles"]),
        # Quantity said after the item, and the script's own digits.
        ("கோலா மூன்று", ["கோலா 3"]),
        ("কোলা তিনটে", ["কোলা 3"]),
        ("కోలా మూడు", ["కోలా 3"]),
        ("कोला तीन", ["कोला 3"]),
        ("௨ கோலா", ["2 கோலா"]),
        ("২ কোলা আর ৩ নুডলস", ["2 কোলা", "3 নুডলস"]),
        ("౨ కోలా", ["2 కోలా"]),
        ("२ कोला आणि ३ नूडल्स", ["2 कोला", "3 नूडल्स"]),
        # Units said in the language.
        ("ஒரு கிலோ உப்பு", ["1 kg உப்பு"]),
        ("এক কেজি লবণ", ["1 kg লবণ"]),
        ("ఒక కిలో ఉప్పు", ["1 kg ఉప్పు"]),
        ("एक किलो मीठ", ["1 kg मीठ"]),
        # Romanised: numbers, "and" and a few verbs around catalogue names. Nothing more is claimed.
        ("rendu cola matrum oru noodles", ["2 cola", "1 noodles"]),
        ("duto cola ebong ekta noodles dao", ["2 cola", "1 noodles"]),
        ("rendu cola mariyu oka noodles ivvandi", ["2 cola", "1 noodles"]),
        ("don cola aani ek noodles dya", ["2 cola", "1 noodles"]),
    ],
)
def test_sentences_are_split_into_items_with_their_quantities(transcript, items):
    assert split_items(transcript, NAMES) == items


@pytest.mark.parametrize("language", LANGUAGES)
def test_what_each_sentence_asks_of_the_bill(language):
    said = ((ADD, "add"), (ADD_MORE, "add"), (REMOVE, "remove"), (CHANGE, "set_quantity"), (TOTAL, "total"), (CLEAR, "clear"))
    assert [command(sentences[language])[0] for sentences, _ in said] == [intent for _, intent in said]


def test_a_command_word_is_not_seen_inside_another_word():
    assert command("বাদাম দুটো")[0] == "add"  # "বাদাম" (peanuts) begins like "বাদ" (leave out)
    assert command("বাদাম বাদ দাও")[0] == "remove"
    assert split_items("বাদাম দুটো", NAMES) == ["বাদাম 2"]


def test_scripts_are_read_alike_digits_units_and_letters_in_their_places():
    assert plain("২ কোলা, ௩ கோலா, ౪ కోలా, ५ कोला।") == "2 কোলা, 3 கோலா, 4 కోలా, 5 कोला."
    assert plain("750 எம்எல், 750 এমএল, 750 ఎంఎల్") == "750 ml, 750 ml, 750 ml"
    # The same name written in four scripts comes out as the same sounds.
    cola = [sound(transliterate(w)) for w in ("कोला", "কোলা", "కోలా")]
    assert set(cola) == {sound("Cola")} and sound(transliterate("கோலா"), hard_and_soft_alike=True) == sound("Cola", hard_and_soft_alike=True)
    for written, name in (("নুডলস", "Noodles"), ("నూడుల్స్", "Noodles"), ("नूडल्स", "Noodles"), ("গ্লুকোজ", "Glucose"), ("గ్లూకోజ్", "Glucose"), ("ग्लुकोज", "Glucose")):
        assert sound(transliterate(written)) == sound(name), written
    # Tamil has one letter for k/g, t/d, p/b: compared with hard and soft sounds as one.
    for written, name in (("நூடுல்ஸ்", "Noodles"), ("குளுக்கோஸ்", "Glucose"), ("மேகி", "Maggi")):
        assert sound(transliterate(written)) != sound(name) or name == "Maggi"
        assert sound(transliterate(written), hard_and_soft_alike=True) == sound(name, hard_and_soft_alike=True), written
    assert sound(transliterate("உப்பு")) != sound("Salt")  # a word of the language is not a catalogue name


def test_malayalam_kannada_and_gujarati_are_read_like_the_other_scripts():
    assert plain("൨ കോള, ೩ ಕೋಲಾ, ૪ કોલા") == "2 കോള, 3 ಕೋಲಾ, 4 કોલા"
    assert plain("750 എംഎൽ, 750 ಎಂಎಲ್, 750 એમએલ, 1 കിലോ, 1 ಕೆಜಿ, 1 કિલો") == "750 ml, 750 ml, 750 ml, 1 kg, 1 kg, 1 kg"
    for written, name in (
        ("കോള", "Cola"), ("ಕೋಲಾ", "Cola"), ("કોલા", "Cola"),
        ("നൂഡിൽസ്", "Noodles"), ("ನೂಡಲ್ಸ್", "Noodles"), ("નૂડલ્સ", "Noodles"),
        ("ഗ്ലൂക്കോസ്", "Glucose"), ("ಗ್ಲೂಕೋಸ್", "Glucose"), ("ગ્લુકોઝ", "Glucose"),
        ("മാഗി", "Maggi"), ("ಮ್ಯಾಗಿ", "Maggi"), ("મેગી", "Maggi"), ("ജി", "G"), ("ಜಿ", "G"), ("જી", "G"),
    ):  # fmt: skip
        assert sound(transliterate(written)) == sound(name), written
    for salt in ("ഉപ്പ്", "ಉಪ್ಪು", "મીઠું"):
        assert sound(transliterate(salt)) != sound("Salt"), salt
    # A command word is a whole word or a telling beginning, never a piece of another word.
    assert command("દૂરદર્શન બે")[0] == "add" and command("કોલા દૂર કરો")[0] == "remove"
    assert split_items("ബിസ്കറ്റ് രണ്ട്", NAMES) == ["ബിസ്കറ്റ് 2"]  # "ബിസ്..." is not the bill word "ബിൽ"
    assert split_items("ಬಿಸ್ಕೆಟ್ ಎರಡು", NAMES) == ["ಬಿಸ್ಕೆಟ್ 2"] and split_items("બિસ્કિટ બે", NAMES) == ["બિસ્કિટ 2"]


# ---- through the API: the catalogue decides, and the merchant confirms ----


@pytest.mark.parametrize("language", LANGUAGES)
def test_items_are_offered_from_this_merchants_catalogue_with_the_quantity_said(client_a, language):
    seed(client_a)
    noodles, cola = ask(client_a, ADD[language])["lines"]
    # A name heard in the language is a suggestion: never preselected, quantity as said.
    assert (noodles["quantity"], noodles["match"], noodles["product"]) == ("2.000", "ambiguous", None)
    assert offered(noodles) == ["Instant Noodles 35g", "Instant Noodles 70g"]  # which size is for the merchant to say
    assert (cola["quantity"], cola["product"]) == ("1.000", None)
    assert offered(cola) == ["Cola 750ml"]  # the size said picks the variant; "Cola" alone is not offered
    [biscuits] = ask(client_a, ADD_MORE[language])["lines"]
    assert (biscuits["quantity"], offered(biscuits), biscuits["product"]) == ("3.000", ["Glucose-G Biscuits 250g"], None)


@pytest.mark.parametrize(
    "transcript",
    ["இரண்டு உப்பு சேர்", "দুটো লবণ যোগ করো", "రెండు ఉప్పు చేర్చండి", "दोन मीठ जोडा", "രണ്ട് ഉപ്പ് ചേർക്കൂ", "ಎರಡು ಉಪ್ಪು ಸೇರಿಸಿ", "બે મીઠું ઉમેરો"],
)  # "two salt" in each language: the word for salt, not a catalogue name
def test_a_word_that_is_not_a_catalogue_name_is_not_found_and_nothing_is_substituted(client_a, transcript):
    seed(client_a)
    [line] = ask(client_a, transcript)["lines"]
    assert (line["quantity"], line["match"], line["product"], line["candidates"]) == ("2.000", "unmatched", None, [])


@pytest.mark.parametrize("language", LANGUAGES)
def test_commands_are_about_the_open_bill_and_change_nothing_themselves(client_a, language):
    catalog = seed(client_a)
    cart = create_cart(client_a)
    for name in ("Cola 750ml", "Instant Noodles 70g", "Table Salt 1kg"):
        client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": catalog[name]["id"]})

    removed = ask(client_a, REMOVE[language], cart)
    assert removed["intent"] == "remove"
    assert [(offered(line), line["product"]) for line in removed["lines"]] == [(["Cola 750ml"], None)]  # offered, not done

    changed = ask(client_a, CHANGE[language], cart)
    assert changed["intent"] == "set_quantity"
    assert [(line["quantity"], offered(line), line["product"]) for line in changed["lines"]] == [("4.000", ["Instant Noodles 70g"], None)]

    for sentences, intent in ((TOTAL, "total"), (CLEAR, "clear")):
        assert ask(client_a, sentences[language], cart) == {"transcript": sentences[language], "intent": intent, "lines": []}

    # Something not on the bill cannot be removed from it, and no other merchant's bill can be looked at.
    assert ask(client_a, REMOVE[language])["lines"][0]["match"] == "unmatched"
    items = client_a.get(f"/api/v1/carts/{cart['id']}").json()["items"]
    assert sorted((i["product_name"], i["quantity"]) for i in items) == [("Cola 750ml", "1.000"), ("Instant Noodles 70g", "1.000"), ("Table Salt 1kg", "1.000")]


def test_another_merchants_bill_and_catalogue_stay_out_of_reach(client_a, client_b):
    catalog = seed(client_a)
    create_product(client_b, name="Rice 1kg", price="60.00")
    cart = create_cart(client_a)
    client_a.post(f"/api/v1/carts/{cart['id']}/items", json={"product_id": catalog["Cola"]["id"]})
    assert client_b.post(PARSE, json={"transcript": REMOVE["tamil"], "cart_id": cart["id"]}).status_code == 404
    # Store B sells no cola: Store A's is never offered to it, in any language.
    assert len(LANGUAGES) == 7
    for language in LANGUAGES:
        lines = client_b.post(PARSE, json={"transcript": ADD[language]}).json()["lines"]
        assert all(line["product"] is None and line["candidates"] == [] for line in lines), language
