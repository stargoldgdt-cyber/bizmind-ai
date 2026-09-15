# Amazon — Flat File V2 settlements

GCC Phase 2, built and verified 2026-09-15. How BizMind reads an Amazon
settlement report into the ledger ([LEDGER.md](LEDGER.md)).

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
profit figure. The Phase 3 P&L test will assert all three outcomes.

The owner's 19.1% take rate needs a written definition in Phase 3 (it is
19.03% or 19.20% depending on whether COD lines count).

## 5. Code and tests

| Path | Role |
| --- | --- |
| `src/services/marketplaces/amazon/flat-file-v2.ts` | Detection, rejections, date parsing, normalisation, the rules mirror |
| `src/services/marketplaces/adapters.ts` | Registers the Amazon adapter (the only registration) |
| `src/app/api/v1/ledger-files/route.ts` | Upload: session business, account check, parse, detect, normalise, build, apply |
| `src/app/(app)/marketplaces/` | Marketplace accounts (owner adds) |
| `src/app/(app)/imports/settlement/` | Upload a settlement |
| `src/app/(app)/imports/[id]/` | A ledger file: settlements, contents, withdraw/restore |

- `npm run test:amazon` — offline, in `npm run verify`: detection and
  rejections, dates and signs, every row accounted for, classification, what it
  refuses to guess, payload acceptance, rules parity with migration 0031.
- `npm run test:amazon-ledger` — live, invented file: the seeded rules, a .txt
  file accepted, exact totals per kind, reconciliation, the UNMAPPED warning,
  Data Sources counts, duplicate upload, withdrawal, tenant isolation.
- `npm run test:amazon-acceptance -- <file> <file> …` — live, the owner's real
  files, local only. Reads only the files named, never a folder; skips when
  none is given.
