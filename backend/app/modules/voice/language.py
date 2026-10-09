"""What a shopkeeper's speech contains besides English: Hindi in Devanagari, and Hinglish (Hindi
said or written in Roman letters, mixed with English).

Only words of the *sentence* are known here: numbers, "and", "add ... to the bill", units, and
the few commands the bill understands. No product is known. A product's name said in Hindi
reaches the catalogue as sounds ("मैगी" -> "maigee"), and a name that only sounds like a catalogue
name is offered to the merchant, never chosen for them (app.modules.voice.service).
"""

import re
import unicodedata
from typing import Literal

from app.modules.voice import regional


def _nfc(*words: str) -> set[str]:
    return {unicodedata.normalize("NFC", w) for w in words}


NUMBER_WORDS = {
    # Hinglish
    "ek": "1", "do": "2", "teen": "3", "char": "4", "chaar": "4", "paanch": "5", "panch": "5", "chhe": "6", "cheh": "6",
    "saat": "7", "aath": "8", "nau": "9", "das": "10", "gyarah": "11", "barah": "12", "baarah": "12",
    # Hindi
    "एक": "1", "दो": "2", "तीन": "3", "चार": "4", "पांच": "5", "पाँच": "5", "छह": "6", "छः": "6", "छे": "6",
    "सात": "7", "आठ": "8", "नौ": "9", "दस": "10", "ग्यारह": "11", "बारह": "12",
}  # fmt: skip
CONNECTORS = _nfc("aur", "phir", "tatha", "और", "फिर", "तथा", "एंड")
# "kar do", "जोड़ दो": after these the word "do" / "दो" is the verb ("do it"), not the number two.
VERBS = _nfc("kar", "kr", "jod", "jor", "hata", "hta", "nikal", "nikaal", "de", "laga", "rakh", "कर", "जोड़", "हटा", "निकाल", "दे", "डाल", "लगा", "रख")
FILLER = _nfc(
    "bhaiya", "bhaia", "bhai", "bill", "mein", "mai", "main", "se", "ko", "ki", "ka", "ke", "kar", "karo", "kardo", "karna",
    "kijiye", "dijiye", "dena", "de", "jodo", "jod", "joddo", "jodna", "dalo", "chahiye", "zara", "jara", "bhi", "hai", "hain",
    "बिल", "में", "से", "को", "की", "का", "के", "कर", "करो", "करना", "कीजिए", "दीजिए", "देना", "दे", "जोड़", "जोड़ो", "जोड़ना",
    "डाल", "डालो", "चाहिए", "ज़रा", "जरा", "भी", "है", "हैं", "भैया", "भाई", "ऐड", "एड", "प्लीज़", "प्लीज",
)  # fmt: skip
# Units as said in Hindi, in the spelling the catalogue matcher knows.
UNITS = {
    "एमएल": "ml", "मिली": "ml", "मिलीलीटर": "ml", "लीटर": "l", "किलो": "kg", "किलोग्राम": "kg", "केजी": "kg", "ग्राम": "g",
    "kilo": "kg", "kilos": "kg", "पैकेट": "packet", "पीस": "pcs", "दर्जन": "dozen", "darjan": "dozen",
}  # fmt: skip
UNITS = {unicodedata.normalize("NFC", k): v for k, v in (UNITS | regional.UNITS).items()}
NUMBER_WORDS = {unicodedata.normalize("NFC", k): v for k, v in (NUMBER_WORDS | regional.NUMBERS).items()}
CONNECTORS |= _nfc(*regional.CONNECTORS)
FILLER |= _nfc(*regional.FILLER)
# Tamil, Bengali, Telugu and Marathi words of the sentence, by how they begin (see regional),
# and the small words those languages put after a name ("to", "of", "as").
SENTENCE_STEMS = tuple(
    sorted(
        _nfc(
            *regional.STEMS, *regional.REMOVE, *regional.CHANGE, *regional.TOTAL, *regional.PARTICLES,
            "ஆக", "కి", "కు", "గా", "ని", "টা", "কে", "করে", "ला", "ची", "चे", "चा",
        )
    )
)  # fmt: skip

_DIGITS = str.maketrans({d: str(v) for digits in ("०१२३४५६७८९", *regional.DIGITS) for v, d in enumerate(digits)})
# Devanagari, Bengali, Gujarati, Tamil, Telugu, Kannada, Malayalam
_INDIAN_SCRIPT = re.compile(r"[\u0900-\u097F\u0980-\u09FF\u0A80-\u0AFF\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]")
_TAMIL = re.compile(r"[\u0B80-\u0BFF]")


def begins(word: str, stems: tuple[str, ...]) -> bool:
    """`word` is one of `stems`, or begins with one long enough to be telling (four characters:
    "বাদ" is "leave out", and also how "বাদাম", peanuts, begins)."""
    return any(word == stem or (len(stem) >= 4 and word.startswith(stem)) for stem in stems)


def sentence_word(word: str) -> bool:
    """A word in an Indian script that belongs to the sentence, not to any item."""
    return not word.isascii() and begins(unicodedata.normalize("NFC", word), SENTENCE_STEMS)
_DEVANAGARI = re.compile(r"[ऀ-ॿ]")


def plain(transcript: str) -> str:
    """The transcript in one spelling: composed letters, ASCII digits, a full stop for the danda,
    and Hindi unit words as the units they name ("750 एमएल" -> "750 ml")."""
    text = unicodedata.normalize("NFC", transcript).translate(_DIGITS).replace("।", ". ")
    tokens = []
    for token in text.split():
        word = token.strip(".,;:!?")
        tokens.append(token.replace(word, UNITS[word.lower()]) if word.lower() in UNITS else token)
    return " ".join(tokens)


def in_indian_script(text: str) -> bool:
    """Written in Devanagari (Hindi, Marathi), Bengali, Gujarati, Tamil, Telugu, Kannada or Malayalam letters."""
    return _INDIAN_SCRIPT.search(text) is not None


def is_tamil(text: str) -> bool:
    return _TAMIL.search(text) is not None


# ---- commands ----

Intent = Literal["add", "remove", "set_quantity", "total", "clear"]

_CLEAR = re.compile(
    r"\b(?:clear|empty)\b.*\b(?:bill|cart)\b|\b(?:bill|cart)\b.*\b(?:clear|khali|khaali|saaf)\b"
    r"|बिल\s*(?:को\s*)?(?:खाली|साफ़|साफ|क्लियर)|(?:सब\s*कुछ|सब|पूरा\s*बिल|sab\s*kuch|sab|pura\s*bill)\s*(?:हटा|hata)",
    re.I,
)
_TOTAL = re.compile(r"\btotal\b|\bhow much\b|\bkitna\b|कुल|कितना|टोटल", re.I)
_ADD = re.compile(r"\badd\b|\bjod\w*|जोड़|ऐड|एड", re.I)
REMOVE = _nfc("remove", "delete", "cancel", "from", "the", "my", "hata", "hatao", "hatado", "hta", "nikal", "nikalo", "nikaal", "हटा", "हटाओ", "निकाल", "निकालो")
CHANGE = _nfc("change", "quantity", "qty", "make", "set", "to", "the", "my", "of", "badal", "badlo", "मात्रा", "क्वांटिटी", "बदल", "बदलो")
_REMOVE = re.compile(r"\b(?:remove|delete|cancel|hata\w*|hta|nikal\w*|nikaal\w*)\b|हटा|निकाल", re.I)
_CHANGE = re.compile(r"\b(?:quantity|qty|change|badal\w*|badlo)\b|\b(?:make|set)\b.*\bto\b|मात्रा|क्वांटिटी|बदल", re.I)


def _said(stems: tuple[str, ...]) -> re.Pattern[str]:
    """A word beginning with one of `stems` (the whole word, for a stem too short to be telling)."""
    stems = tuple(unicodedata.normalize("NFC", s) for s in stems)
    return re.compile("|".join(rf"(?<!\S){re.escape(s)}" + ("" if len(s) >= 4 else r"(?![^\s.,!?।])") for s in stems))


_REGIONAL = {
    "clear": re.compile("|".join(unicodedata.normalize("NFC", p) for p in regional.CLEAR)),
    "remove": _said(regional.REMOVE),
    "set_quantity": _said(regional.CHANGE),
    "total": _said(regional.TOTAL),
    "add": _said(regional.ADD),
}


def command(transcript: str) -> tuple[Intent, set[str]]:
    """What the sentence asks of the bill, and the words that only say so (not part of any item).
    Anything that is not clearly another command adds items: that is what the counter is for."""
    text = unicodedata.normalize("NFC", transcript)
    if _CLEAR.search(text) or _REGIONAL["clear"].search(text):
        return "clear", set()
    if _REMOVE.search(text) or _REGIONAL["remove"].search(text):
        return "remove", REMOVE
    if _CHANGE.search(text) or _REGIONAL["set_quantity"].search(text):
        return "set_quantity", CHANGE
    if (_TOTAL.search(text) or _REGIONAL["total"].search(text)) and not (_ADD.search(text) or _REGIONAL["add"].search(text)):
        return "total", set()
    return "add", set()


# ---- Hindi names as sounds ----

_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
    "ष": "sh", "स": "s", "ह": "h", "ऩ": "n", "ऱ": "r", "ळ": "l", "ऴ": "l",
}  # fmt: skip
_NUKTA = {"क": "q", "ख": "kh", "ग": "g", "ज": "z", "फ": "f", "ड": "r", "ढ": "rh"}
_VOWELS = {"अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऋ": "ri", "ऎ": "e", "ऒ": "o", "ऍ": "e"}
_SIGNS = {"ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ृ": "ri", "ॅ": "e", "ॆ": "e", "ॊ": "o"}
_NASAL = {"ं": "n", "ँ": "n"}


# Malayalam writes a consonant that ends a syllable as a letter of its own ("ൽ" in "നൂഡിൽസ്"):
# here it is that consonant with no vowel after it.
_CHILLU = str.maketrans({"ൺ": "ണ്", "ൻ": "ന്", "ർ": "ര്", "ൽ": "ല്", "ൾ": "ള്", "ൿ": "ക്"})


def _as_devanagari(ch: str) -> str:
    for block in (0x0980, 0x0A80, 0x0B80, 0x0C00, 0x0C80, 0x0D00):  # Bengali, Gujarati, Tamil, Telugu, Kannada, Malayalam
        if block <= ord(ch) < block + 0x80:
            return chr(ord(ch) - block + 0x0900)
    return ch


def transliterate(text: str) -> str:
    """Devanagari as Roman letters, sound for sound ("मैगी" -> "maigee", "पारले" -> "paarle", "कोक" -> "kok").
    Everything else passes through. It is a spelling of the sound, not of any product."""
    # Bengali, Gujarati, Tamil, Telugu, Kannada and Malayalam letters sit in their Unicode blocks in the same order as the
    # Devanagari ones (the blocks were laid out alike): each is read as the letter in its place.
    text = "".join(_as_devanagari(ch) for ch in unicodedata.normalize("NFC", text).translate(_CHILLU))
    text = unicodedata.normalize("NFD", text)
    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in _CONSONANTS:
            sound_ = _CONSONANTS[ch]
            if i + 1 < len(text) and text[i + 1] == "़":
                sound_ = _NUKTA.get(ch, sound_)
                i += 1
            out.append(sound_)  # the unwritten "a" after a consonant is left out: only written vowels are spelt
        elif ch == "्":
            pass
        elif ch in _VOWELS:
            out.append(_VOWELS[ch])
        elif ch in _SIGNS:
            out.append(_SIGNS[ch])
        elif ch in _NASAL:
            out.append(_NASAL[ch])
        elif ch in "ःऽ":
            pass
        else:
            out.append(ch)
        i += 1
    return unicodedata.normalize("NFC", "".join(out))


_LETTER_NAMES = {"a": "e", "b": "bi", "c": "si", "d": "di", "g": "ji", "j": "je", "k": "ke", "p": "pi", "t": "ti", "v": "vi", "z": "jed"}


def sound(word: str, *, hard_and_soft_alike: bool = False) -> str:
    """The consonants a word is said with, for comparing a heard name with a written one:
    "Maggi" and "maigee" are both "mg", "Coke" and "kok" both "kk". Vowels differ too much
    between a transliteration and a brand's own spelling to be compared."""
    w = re.sub(r"[^a-z]", "", word.lower())
    w = _LETTER_NAMES.get(w, w)  # a lone letter is said by its name: "G" is "ji"
    w = w.replace("chh", "C").replace("ch", "C").replace("sh", "s").replace("ph", "f").replace("ck", "k")
    w = re.sub(r"c(?=[eiy])", "s", w).replace("c", "k").replace("C", "c")
    # "z" is said, and in Indian scripts mostly written, as "j" or "s" ("glucose" -> "ग्लुकोज"): one sound here.
    w = w.replace("q", "k").replace("x", "ks").replace("z", "s").replace("j", "s").replace("w", "v")
    w = re.sub(r"(.)\1+", r"\1", w)  # "maggi" -> "magi"
    w = re.sub(r"[aeiouyh]", "", w)
    # Tamil writes k and g with one letter, and likewise t/d, p/b and ch/j/s: heard in Tamil they are one sound.
    return w.translate(_HARD) if hard_and_soft_alike else w


_HARD = str.maketrans("gdbjc", "ktpss")
