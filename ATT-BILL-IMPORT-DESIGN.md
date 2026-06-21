# AT&T Bill Auto-Split — Design

**Status:** approved 2026-06-08 · ships in McQuire Tracker (desktop)

## Goal
Upload AT&T wireless bill PDFs into the app. It parses each bill, finds the
business line **832.687.0468**'s portion, matches the bill to the autopay card
charge (deduping double-posted charges), and splits that charge automatically:
the **0468 amount → Peak 10 / Telephone & Communication**, the **remainder →
Personal**. Zero intervention beyond the upload — *except* it refuses to guess
when it can't match confidently.

## What the bills look like (account 287301218152, "8152")
- Page 1: `Total due $X`, `AutoPay is scheduled for <date>` (the 20th of the next
  month), `Issue Date: <date>` (the 27th).
- Page 2: a per-line summary table; the 0468 row is
  `832.687.0468 KYLE MCQUIRE <n> ... $<lineTotal>` — the **last number on the row
  is the line's total** (e.g. Apr = $91.77). The table's `Total` row = the bill
  total (= the autopay amount).
- Verified across Dec 2025–Apr 2026: 0468 totals $86.73–$92.59; bill totals
  ~$463–$489.

## Parsed bill (what the parser extracts)
`{ accountNumber, issueDate, autopayDate, billTotal, line0468Amount, sourceFile, sourceHash }`

## Matching rules (locked with Kyle)
A card charge is a **confident match** for a bill when ALL hold:
1. **Merchant looks like AT&T** (description contains at&t / att / mobility /
   bill payment).
2. **Amount = bill total, to the cent.**
3. **Charge date ∈ [bill issue date, bill issue date + 55 days].**

**Duplicate collapse (runs first):** among candidate charges, any with the
**exact same amount within 4 days** of each other are duplicates → keep the
**earliest**, mark the rest `Exclude` ("Duplicate of <first> — AT&T autopay") so
they don't double-count. This collapses a double-posted autopay to one charge.

**Resolution:**
- Exactly **one** charge after dedup → **auto-split** it (0468 → Peak 10 /
  Telephone & Communication; remainder → Personal). Done, silent.
- **Zero** charges (the usual case — uploaded ~3 weeks before autopay posts) →
  store as a **pending** bill; re-check on every transaction import; auto-split
  the moment its charge appears.
- **Two or more** non-duplicate same-total charges → **hold for one-tap confirm**
  in the Review Queue. Never a silent wrong split.

The bill is **never added as a transaction** — it only drives the split of the
real card charge (this is the "dedup against the card charge").

## Components (each testable in isolation)
1. `electron/services/att-bill-parser.ts` — pure: `(pdfText) → ParsedBill`.
   (PDF→text via `pdf-parse`; the field extraction is the tested part.)
2. `electron/services/att-bill-matcher.ts` — pure:
   `(parsedBill, candidateCharges) → { action: 'split'|'pending'|'review', target?, duplicates? }`.
   Reuses the existing `splitTransaction` to apply the split.
3. **DB:** new `att_bills` table (parsed bills + status + matched txn id) via a
   schema migration. Re-uploading the same bill (by `sourceHash`) is a no-op.
4. **IPC:** `att-bill:import` (parse + store + try-match), `att-bill:list`,
   `att-bill:confirm-match`. Re-match pending bills is invoked from the existing
   import/sync path so new charges trigger pending splits.
5. **UI:** an "AT&T Bills" panel — drag/drop + file picker upload, and a list
   showing each bill's state (✓ split / ⏳ waiting for charge / ⚠ needs confirm).

## Edge cases
- Upload before the charge posts → pending; applies automatically later.
- Re-upload same PDF → recognized by hash, not reprocessed.
- Amount/date off, or 2+ look-alike charges → one-tap confirm, never silent.
- A charge already split/manually-classified → left alone.
- 0468 + remainder always = bill total exactly (line totals sum to the bill).

## Not doing (YAGNI)
- No support for other AT&T accounts/lines in v1 (only 0468 on the 8152 account).
- No watched-folder upload (in-app upload only, per Kyle).
- No editing parsed amounts in the UI (parser is reliable; mismatches hold for
  confirm instead).
