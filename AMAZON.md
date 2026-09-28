# Amazon — settlements, and VAT tax invoices/credit notes

GCC Phase 2, built and verified 2026-09-15. How BizMind reads an Amazon
settlement report into the ledger ([LEDGER.md](LEDGER.md)). §6 covers the
optional VAT tax invoice/credit note upload added 2026-09-28.

---

## 1. The one report BizMind reads

**Seller Central → Payments → Reports repository → Settlement report, downloaded
as Flat File V2 (.txt).** Tab-separated, 24 columns, one settlement per file.

| Amazon report | What BizMind does |
| --- | --- |
| Settlement report, Flat File V2 | Read (`amazon.settlement.flat_file_v2`) |
| Settlement report, Flat File (V1) | Refused: "download Flat File V2 instead" |
| Date Range (transaction) report | Refused: it is a summary, not a settlement |
| Summary / statement reports | Refused |
| Anything else | "BizMind does not recognise this file" |

A file whose columns were changed by a spreadsheet program is refused rather
than converted back.

## 2. What was learned from real files

Four Amazon.ae settlements supplied by the owner (June–August 2026). Only
aggregates are recorded here; the files never entered the repository.

- Each file is exactly one settlement. Its **first data row is the header**: no
  amount, but the settlement period, the total and the deposit date.
- Data rows leave `currency` blank; the currency comes from the header row.
- Dates are `dd.mm.yyyy HH:MM:SS UTC`. Only `posted-date-time` is used for a
  line's instant; a date without a time is refused, never guessed.
- Amounts use a dot and no thousands separator; anything else is refused.
- `marketplace-name` is blank on some non-order rows. It is not needed.
- COD charge and COD fee cancel to zero on every order seen.
- Storage fee lines reported as `0.00` are recorded as zero lines.
- No tax on sales and no reserve lines appeared.
- **Every settlement reconciled exactly**: the sum of its lines equals the
  total Amazon reported.

## 3. Classification (21 rules, owner-approved)

Match key: `transaction-type | amount-type | amount-description`. Rules are
data in `ledger_mapping_rules` (GLOBAL, `SAMPLE_VERIFIED`), seeded by migration
0031 and mirrored in `src/services/marketplaces/amazon/flat-file-v2.ts`; a test
fails if the two differ.

| Match key | Side · category · subcategory | Level |
| --- | --- | --- |
| Order · ItemPrice · Principal | PNL · REVENUE · principal (units as reported) | Order line |
| Order · ItemPrice · Shipping | PNL · REVENUE · shipping_charged | Order line |
| Order · ItemPrice · COD | PNL · OTHER_INCOME · cod_charge | Order line |
| Order · ItemFees · CODFee | PNL · MARKETPLACE_FEE · cod | Order line |
| Order · ItemFees · Commission | PNL · MARKETPLACE_FEE · referral | Order line |
| Order · ItemFees · FBAPerUnitFulfillmentFee | PNL · FULFILMENT · fba_per_unit | Order line |
| Order · ItemFees · ShippingChargeback | PNL · FULFILMENT · shipping_chargeback | Order line |
| Order · ItemFees · VariableClosingFee | PNL · MARKETPLACE_FEE · closing | Order line |
| Order · Promotion · Shipping | PNL · PROMOTION · shipping | Order line |
| Refund · ItemPrice · Principal | PNL · REFUND · principal (1 derived unit per line) | Order line |
| Refund · ItemPrice · Shipping | PNL · REFUND · shipping_charged | Order line |
| Refund · ItemPrice · COD | PNL · OTHER_INCOME · cod_charge | Order line |
| Refund · ItemFees · CODFee | PNL · MARKETPLACE_FEE · cod | Order line |
| Refund · ItemFees · Commission | PNL · MARKETPLACE_FEE · referral | Order line |
| Refund · ItemFees · RefundCommission | PNL · MARKETPLACE_FEE · refund_administration | Order line |
| Refund · ItemFees · ShippingChargeback | PNL · FULFILMENT · shipping_chargeback | Order line |
| Refund · Promotion · Shipping | PNL · PROMOTION · shipping | Order line |
| ServiceFee · Cost of Advertising · TransactionTotalAmount | PNL · ADVERTISING · sponsored_ads | Marketplace |
| AmazonFees · Premium Services Fee · Base fee | PNL · MARKETPLACE_FEE · premium_services (SP 360) | Marketplace |
| AmazonFees · Premium Services Fee · Tax on fee | TAX · FEE_VAT · premium_services (input VAT, B1) | Marketplace |
| FBAFees · FBA Inventory Storage Fee · Base fee | PNL · FULFILMENT · storage | Marketplace |
| other-transaction · other-transaction · Paid Services Fee | PNL · MARKETPLACE_FEE · premium_services (SP 360 on one line, **VAT included**; migration 0044) | Marketplace |

Amounts keep Amazon's sign. Marketplace-level lines are never spread across
products (A7). A code not in the table is recorded as **UNMAPPED** with its
amount and a row warning naming the code; it counts towards nothing until a
rule is added by migration.

The header row becomes a **settlement** (period, reported total, deposit date)
and a **payout** of the reported total on the deposit date. That payout is what
Amazon *says* it sent; matching it to the bank is Phase 6.

## 4. Acceptance: July 2026 reproduced

`npm run test:amazon-acceptance -- <file> <file> …` loads the named real
files into a throwaway business through the real upload path, adds up the July
ledger lines exactly, then deletes the business. Result on 2026-09-15:

| Figure (July, by posted date) | Ledger | Owner measured |
| --- | --- | --- |
| Gross (Principal + Shipping) | 61,429.11 | 61,429 |
| Referral commission, net of refund reversals | −4,327.27 | −4,327 |
| FBA fulfilment | −7,112.92 | −7,113 |
| Refunded sales | −5,207.13 | −5,207 |
| Ads + SP 360 fee + its VAT | −7,780.18 | −7,780 |
| Sum of P&L and tax lines (including VAT on fees) | 36,432.97 | 36,433 |
| Units sold / refund lines | 296 / 25 | 296 / 25 |

All 1,154 July lines recognised; all four settlements reconcile.

**P&L contribution (B1, decided 2026-09-15)** before COGS and operating
expenses depends on the Amazon.ae account's fee-VAT treatment (AED 119.79 VAT
on the SP 360 fee):

| Treatment | Final P&L contribution |
| --- | --- |
| Unknown (default) | Incomplete — warning "VAT treatment unknown: AED 119.79"; informational "Contribution before fee-VAT treatment: AED 36,552.76" |
| Recoverable | AED 36,552.76; the VAT is input VAT on the tax ledger |
| Not recoverable | AED 36,432.97; the VAT is a separate expense line |

The 36,432.97 in the table above is the plain sum of P&L and tax lines, which
is how the Phase 2 test proves the ledger holds the right lines; it is not a
profit figure. The P&L engine reproduces all three outcomes from the real
files (Phase 3, below).

Take rate is not defined yet (B15). The owner's historical 19.1% could not be
reproduced exactly from these files (DECISIONS.md, 2026-09-15).

### In the four-layer model (Phase 3)

Migration 0032 restates the 21 codes as HIGH classification rules; the lines
already stored do not change.

| Code | Type · category · subcategory | P&L treatment |
| --- | --- | --- |
| Order · ItemPrice · Principal | Revenue · Product sales · Principal | Increase revenue |
| Order · ItemPrice · Shipping | Revenue · Shipping income · Shipping charged | Increase revenue |
| Order / Refund · ItemPrice · COD | Revenue · Other income · COD charge | Increase revenue |
| Order / Refund · ItemFees · CODFee | Expense · Payment and COD fees · COD fee | Increase expense |
| Order / Refund · ItemFees · Commission | Expense · Marketplace fees · Referral commission | Increase expense |
| Order · ItemFees · VariableClosingFee | Expense · Marketplace fees · Variable closing fee | Increase expense |
| AmazonFees · Premium Services Fee · Base fee | Expense · Marketplace fees · SP 360 premium services | Increase expense |
| Refund · ItemFees · RefundCommission | Expense · Refund fees · Refund administration fee | Increase expense |
| Order · ItemFees · FBAPerUnitFulfillmentFee | Expense · Fulfillment · FBA per-unit fulfilment | Increase expense |
| Order / Refund · ItemFees · ShippingChargeback | Expense · Fulfillment · Shipping chargeback | Increase expense |
| FBAFees · FBA Inventory Storage Fee · Base fee | Expense · Storage · FBA storage | Increase expense |
| ServiceFee · Cost of Advertising · TransactionTotalAmount | Expense · Advertising · Sponsored ads | Increase expense |
| Order / Refund · Promotion · Shipping | Revenue · Seller-funded discounts · Shipping promotion | Decrease revenue |
| Refund · ItemPrice · Principal / Shipping | Revenue · Sales refunds · Refunded principal / shipping | Decrease revenue |
| AmazonFees · Premium Services Fee · Tax on fee | Tax · Input VAT · VAT on SP 360 fee | Conditional (account VAT setting) |
| other-transaction · other-transaction · Paid Services Fee | Expense · Marketplace fees · SP 360 premium services, VAT inside the amount | Increase expense; contribution not final (FEE_VAT_NOT_SEPARATED) while VAT on fees is Recoverable |

**July 2026 from the P&L engine** (real files, 2026-09-16):

| Figure | AED |
| --- | --- |
| Gross sales | 61,429.11 |
| Net sales (refunds −5,242.13, shipping promotions −281.77) | 55,905.21 |
| Other income (COD charges) | 100.00 |
| Marketplace fees (commission, closing, SP 360, COD fee, refund administration) | −6,908.84 |
| Fulfillment (FBA, shipping chargebacks, storage) | −7,278.92 |
| Advertising | −5,264.69 |
| Contribution, VAT setting Unknown | Incomplete; 119.79 unresolved; informational 36,552.76 |
| Contribution, Recoverable | **36,552.76** |
| Contribution, Non-recoverable | **36,432.97** |

All 1,154 July lines classified automatically; none unknown or under review.

## 5. Code and tests

| Path | Role |
| --- | --- |
| `src/services/marketplaces/amazon/flat-file-v2.ts` | The settlement format: detection, rejections, date parsing, normalisation, the rules mirror |
| `src/services/marketplaces/amazon/tax-documents.ts` | The two tax-document formats (§6): detection, the invoice-line and credit-note-block readers |
| `src/services/marketplaces/amazon/adapter.ts` | Combines the two into the one Amazon adapter (mirrors `noon/adapter.ts`) |
| `src/services/marketplaces/adapters.ts` | Registers the Amazon adapter (the only registration) |
| `src/services/ingestion/parse.ts` | `parseFile()`'s `.pdf` dispatch: extracts text via `pdf-parse`, one row per document |
| `src/app/api/v1/ledger-files/route.ts` | Upload: session business, account check, parse, detect, normalise, build, apply |
| `src/app/(app)/marketplaces/` | Marketplace accounts (owner adds) |
| `src/app/(app)/imports/settlement/` | Upload a settlement |
| `src/app/(app)/imports/[id]/` | A ledger file: settlements, contents, withdraw/restore |

- `npm run test:amazon` — offline, in `npm run verify`: detection and
  rejections, dates and signs, every row accounted for, classification, what it
  refuses to guess, payload acceptance, rules parity with migration 0031.
- `npm run test:amazon-tax-documents` — offline, in `npm run verify`: the two
  new formats, on invented text shaped like the real documents (§6).
- `npm run test:amazon-ledger` — live, invented file: the seeded rules, a .txt
  file accepted, exact totals per kind, reconciliation, the UNMAPPED warning,
  Data Sources counts, duplicate upload, withdrawal, tenant isolation.
- `npm run test:amazon-acceptance -- <file> <file> …` — live, the owner's real
  files, local only. Reads only the files named, never a folder; skips when
  none is given. Checks the ledger sums and, from Phase 3, the P&L engine's
  July figures under all three VAT settings, and (Phase 4) that the dashboard
  offers July with its 1,154 lines across the four settlements, each adding up.

## 6. VAT tax invoices and credit notes (PDF, optional, migration 0057)

The settlement itemises VAT for exactly one fee (Premium Services Fee / SP
360, §3). Every other fee carries 5% UAE VAT that Amazon states only on a
separate monthly document from Seller Central's Tax Document Library: a
**Tax Invoice**, and, when Amazon adjusts an earlier charge, a **Tax Credit
Note**. Seller Central offers no CSV/Excel export of these — PDF only
(confirmed with the owner, 2026-09-28) — so this is the one place BizMind
reads a PDF. Uploading them is entirely optional; an account that only
uploads settlements behaves exactly as before, and no period ever requires
them to be final. See DECISIONS.md, 2026-09-28, for why this exists and how
it was verified against four real documents.

**The one rule that makes this safe:** every fee amount these documents state
is Amazon's own restatement of a fee already recorded through the settlement.
Recording it again would double the fee. So only the **VAT** column is ever
new, P&L-affecting data; the fee amount is kept (for traceability) but
classified `MEMO / INFORMATIONAL` — recorded, never counted. Premium Services
Fee is the one exception in the other direction: the settlement already
states its fee *and* VAT combined (migration 0044), so both columns from the
tax invoice are informational for that one description.

| Format id | Recognised by |
| --- | --- |
| `amazon.tax_invoice` | The extracted text contains "TAX INVOICE" and "Souq.com FZ LLC" |
| `amazon.tax_credit_note` | The extracted text contains "TAX CREDIT NOTE" and "Souq.com FZ LLC" |

Both formats carry a single "text" column — a PDF has no rows or columns, and
unlike a settlement, one PDF is one document, not a table. `parse.ts` hands
the whole extracted text over as one source row; the adapter finds every line
(invoice) or 20-line adjustment block (credit note) inside it and emits
several transactions from that one row via `lineIndex`.

**Fee kinds seeded (`ledger_mapping_rules` and `classification_rules`,
migration 0057, GLOBAL, one shared list generated into both formats — 28
rules on each side):**

| Description on the document | Fee-excl-tax | VAT |
| --- | --- | --- |
| Sales Commission | INFORMATIONAL | **FEE_VAT → INPUT_VAT** (new) |
| Refund Commission | INFORMATIONAL | **FEE_VAT → INPUT_VAT** (new) |
| Variable Closing Fee | INFORMATIONAL | **FEE_VAT → INPUT_VAT** (new) |
| Multitier Per Unit Fee | INFORMATIONAL | **FEE_VAT → INPUT_VAT** (new) |
| Shipping Chargeback | INFORMATIONAL | **FEE_VAT → INPUT_VAT** (new) |
| COD Chargeback Fee | INFORMATIONAL | **FEE_VAT → INPUT_VAT** (new) |
| Paid Services Fee | INFORMATIONAL | INFORMATIONAL (settlement already has both, migration 0044) |

A description not in this table is kept as **UNMAPPED** with a row warning,
exactly like an unrecognised settlement code — never dropped, never blocking
the rest of the document.

**Every one of these rules negates its amount** (migration 0059; the original
migration 0057 wrongly left them `AS_REPORTED`). A tax document prints a
fee or VAT amount as a plain positive magnitude — it never signs it debit or
credit — but every fee and VAT amount BizMind already records, from the
settlement, is stored negative: money the marketplace took. `NEGATE` makes a
tax document's fee/VAT lines match that same convention. A credit note's
already-negative delta (a fee being reduced) negates correctly too: printed
`-AED 32.93` becomes `32.93`, partly reversing the fee's negative total.

**`external_ref`** (new, marketplace-agnostic column on
`financial_transactions`): every line from these documents carries the
invoice or credit-note number it came from, so a VAT figure is traceable back
to its source document. Populated as `null` on settlement-report lines (no
per-line document number exists there).

**Verified against the owner's real four August 2026 documents** (two
invoices, two credit notes; never copied into the repository): all 168 lines
recognised, zero UNMAPPED. The reconciled magnitude, AED 293.95, matches the
original audit (DECISIONS.md, 2026-09-28); its sign was wrong until migration
0059 (DECISIONS.md, 2026-09-28, second entry) — a real settlement holds a
genuine negative VAT-on-fee line the throwaway test business used for the
first verification did not, which is how the sign error passed offline and
live testing against a business with no settlement data.

**A note for whoever touches `parsePdf()` next:** `pdf-parse`'s first call in
a process can throw on a PDF it reads correctly on the next call — hit
reliably on one of the four real credit notes. `extractPdfText()` in
`parse.ts` retries up to three times before giving up; this is a known quirk
in the underlying library on a borderline file, not a sign to add more
retries or a delay.
