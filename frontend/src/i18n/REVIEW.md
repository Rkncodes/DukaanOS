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

## Not translated on purpose

`QR`, `UPI`, `Paytm`, `GST`, `GSTIN`, `CGST`, `SGST`, `DukaanOS`, and the typed examples in
placeholders (a barcode number, "maggi", a sample GSTIN).
