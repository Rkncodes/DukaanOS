# Translation review list

None of the nine non-English dictionaries in `locales/` has been checked by a native speaker.
They were written by the developer tooling, key by key, from the English in `locales/en.ts`.
Until a language is reviewed, treat its wording as a draft.

| Language | File | Reviewed |
|---|---|---|
| Hindi | `hi.ts` | no |
| Hinglish | `hinglish.ts` | no |
| Tamil | `ta.ts` | no |
| Bengali | `bn.ts` | no |
| Telugu | `te.ts` | no |
| Marathi | `mr.ts` | no |
| Malayalam | `ml.ts` | no |
| Kannada | `kn.ts` | no |
| Gujarati | `gu.ts` | no |

## Choices a reviewer should look at first

- **Khata** (the udhaar ledger module). Rendered as the local word for an account book:
  खाता (hi), खाते (mr), ખાતું (gu), খাতা (bn), ఖాతా (te), ಖಾತೆ (kn), கணக்கு (ta), കണക്ക് (ml).
  The Tamil and Malayalam words mean "account" in general and may not read as "credit ledger".
- **Parchi** (a handwritten order slip). Rendered as पर्ची (hi), चिठ्ठी (mr), ચિઠ્ઠી (gu), ফর্দ (bn),
  చీటీ (te), ಚೀಟಿ (kn), சீட்டு (ta), കുറിപ്പ് (ml). Regional usage differs; a shopkeeper may know
  another word.
- **Salaahkaar** (the assistant). Translated as the word for "adviser" in each language rather than
  kept as a name. It is a product name: decide whether it should stay "Salaahkaar".
- **Storefront** is rendered as "online shop" everywhere; **Ledger** and **Outstanding** use
  accounting words that may be more formal than a shopkeeper would say.
- **"Collect ₹…"** (the button that completes a paid bill) is rendered as "take ₹…".
- **"each"** in "₹14.00 each" differs in word order by language; check it reads naturally with a price.
- Loan words (Counter, Vision, Barcode, Scan, Stock, Bill, Discount, Order) are transliterated,
  as they are commonly said. A reviewer may prefer native words in places.

## Screens covered

Every merchant screen and the customer storefront: the app shell and navigation, Settings, Login and
registration, Dashboard, Opportunities (insights), Analytics, Salaahkaar, Counter (all modes: manual,
Vision, By Code, Photo, Parchi, Voice, Paytm, and the receipt), Catalogue (Products, Categories, Stock),
Shop (Orders, Storefront, QR), Khata (customers, ledger, outstanding, payments), and the customer
storefront, cart, checkout and order pages.

## Newer wording to check (screens added after the first pass)

- **Login and registration.** "Log in to your dukaan": Hinglish keeps *dukaan*, Hindi and Marathi write
  दुकान, and the other languages use their own word for shop. A wrong password and an email already registered have
  their own lines (`auth.wrongLogin`, `auth.emailTaken`): check they read as polite, not as an accusation.
- **Error lines (`error.*`).** In every language but English a failed request shows one line per error
  code instead of the backend's English message, so the specific detail (which product, how much stock)
  is lost. The lines were written to be general; check none promises more than it can know.
- **Opportunities.** The backend writes each insight as a fixed English sentence; `features/insights/text.ts`
  recognises those sentences and says them again from the dictionary (`insight.*`). Check the numbers and
  names land in natural places, and the trend words (`insight.trend.*`: climbing, steady, slowing).
- **Customer storefront (`store.*`).** Read by customers, not the merchant: it should sound like a shop
  talking to a customer. The order status headlines (`store.headline.*`) are the most visible.
- **Voice (`voice.*`).** The app's language and the language Voice listens in are separate choices.
  `voice.language` labels the second one and is rendered as "language you speak" (not just "language")
  so the two are not confused; check that reads clearly. The names of the spoken languages in that list
  are each language's own name and are not translated.
- **Vision, Photo, Parchi (`vision.*`, `live.*`, `photo.*`, `parchi.*`, `review.*`).** "Detection",
  "test provider", "reference photo" and "remember this packet" are technical; they were rendered plainly
  (what was seen, a test source, a saved photo of the packet). `live.basis.*` says what a recognition
  rests on ("name read on pack", "matches your photo", "by look only").
- **Counts with one and many (`*.one` / `*.other`).** Some languages (Hindi, Bengali) use the same form
  for both; check the singular reads naturally, e.g. `review.enterQuantity.one`, `voice.removeAll.one`.
- **Paytm (`paytm.*`).** "Sandbox" (Paytm's test mode) is transliterated in several languages. A failed
  payment always says the bill is not paid; keep that sentence unambiguous in review.
- **Receipt (`receipt.*`).** "On khata (udhaar)" keeps the word for credit in brackets; check the
  bracketed word in each language is the one shopkeepers use.

## Not translated on purpose

`QR`, `UPI`, `Paytm`, `GST`, `GSTIN`, `CGST`, `SGST`, `DukaanOS`, `USB`, and the typed examples in
placeholders (a barcode number, "maggi", a sample GSTIN, the demo login).

Also left exactly as it came, in every language, because it is data and not interface: product,
category, customer and store names; what the merchant typed, said or wrote on a parchi; barcodes and
bill numbers; what the recogniser read off a packet; Paytm's own messages and references; the vision and
OCR provider names; Salaahkaar's answers and its example questions (they show how a merchant may type to
it); and, in English, the backend's error messages.
