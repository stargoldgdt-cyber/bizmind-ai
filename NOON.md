# noon — Transaction View and Invoices & Credit Notes

GCC Phase 5, built and verified 2026-09-17. How BizMind reads noon's seller
finance exports into the ledger ([LEDGER.md](LEDGER.md)) and classifies them
automatically ([ARCHITECTURE_BASELINE.md](ARCHITECTURE_BASELINE.md) §C).

---

## 1. The two reports BizMind reads

| noon export | Format id | What it gives |
| --- | --- | --- |
| **Transaction View (item level, with contract selection)**, CSV | `noon.transaction_view.item_level` | Every order, order update, statement fee, payment and balance transfer, with its money split into nine columns. Fee columns **include VAT**. |
| **Invoices and Credit Notes**, CSV | `noon.invoices_credit_notes` | noon's VAT invoices for its own fees (the only place the VAT inside those fees is stated), and the invoices and credit notes noon issued to buyers. |

Upload **both** for each period, to the noon account in the matching currency.
Both are recognised by their exact column headings. A file that repeats a row
already counted for the account is refused, naming the file that holds it.

## 2. What was learned from real files

The owner's July 2026 exports (aggregates only; the files never entered the
repository):

- **Transaction View:** 1,493 rows. Types: `order` 1,244, `order_update` 237,
  `statement_fee` 5, `payment` 5, `balance_transfer` 2. The money columns add
  up exactly to the row total on every row.
- Dates are `YYYY-MM-DD` with no time. A line is kept on that calendar day
  (stored as 00:00 UTC), so it counts in the month noon states.
- Item rows carry the seller SKU; order-level rows (fees and subsidies) do not.
  Rows with no order write the literal `NA`, which is read as blank.
- **Statement fees are advertising**: their title is "Advertising Fee" and they
  add up exactly to the advertising lines of the invoices including VAT
  (AED 4,392.20).
- **Payments** ("Payment Disbursal") are bank transfers noon reports sending:
  five in July, AED 124,817.08.
- **One row is in SAR**, on the "Noon SA" contract (a balance transfer of
  5.01). It is not counted in the AED account; it waits for a SAR account.
- **Invoices:** 955 rows, all AED. 44 statement-fee lines state noon's VAT on
  its fees (AED 1,975.70), plus import VAT recovered from the seller (272.08).
  911 customer invoices and credit notes state the VAT on sales.
- The invoice file names the buyer, their tax number, city and location. Those
  columns (and every issuer and receiver identity column, and free-text Misc)
  are **never stored**.

## 3. Classification (61 rules)

Rules are data (`ledger_mapping_rules` for import, `classification_rules` for
meaning), seeded by migration 0034 from
`src/services/marketplaces/noon/rules.ts`; `npm run test:noon` fails if they
differ.

**Transaction View** — key `type | column | level` (level is `item` or `order`
for orders and order updates):

| Column | Category · line | Confidence | VAT inside |
| --- | --- | --- | --- |
| Net Proceeds (order) | Product sales · Net proceeds (one unit per item line) | High | — |
| Net Proceeds (order update) | Product sales · Order updates (returns and changes, signed). A positive item-level line with a SKU counts as one unit (0085) | Medium | — |
| Referral Fee including VAT | Marketplace fees · Referral fee | High | Yes |
| Fullfilment & Logistics Fees including VAT | Fulfillment · Fulfilment and logistics | High | Yes |
| Shipping Credits including VAT | Shipping income · Shipping credits | Medium | — |
| Other Order Fees including VAT | Marketplace fees · Other order fees | Medium | Yes |
| Order Subsidies including VAT | Subsidy income · Order subsidies | High | — |
| Non-Order Fees including VAT | Marketplace fees · Non-order fees | Medium | Yes |
| Non-Order Subsidies including VAT | Subsidy income · Non-order subsidies | Medium | — |
| statement_fee · Advertising Fee | Advertising · Advertising fee | High | Yes |
| payment · Payment Disbursal | Cash · Payout (also recorded as a reported payout) | High | — |
| balance_transfer | Cash · Transfer | Medium | — |

**Invoices** — each statement-fee line becomes **two** ledger lines that add up
to zero: the stated VAT taken back out of the fee's category, and the same VAT
as Input VAT (its P&L effect follows the account's VAT setting, B1). Import VAT
Recovery moves its whole amount the same way. Fees: Referral Fee, Referral Fee
Adjustment, Directship Outbound Fee, FBN Outbound Fee, Rebates & Discounts
(Directship Outbound Fee), Shipping Fee Rebate, Advertising Fee, Return
Administration Fee, Cancellation Fee, Damaged Returns Fee, Warranty Fee, Import
VAT Recovery. Customer invoices record their VAT as Output VAT owed; credit
notes give it back. Sales themselves stay as noon reports them.

**Until the invoices arrive**, fees still include VAT: contribution shows
"Incomplete — fee VAT not separated" (unless the account's VAT setting is
Non-recoverable, when fees including VAT are the right cost).

## 4. Acceptance: July 2026

`npm run test:noon-acceptance -- <transaction-view.csv> <invoices.csv>` loads
the named real files into a throwaway business through the real upload path,
then deletes it. Result on 2026-09-17:

| Figure (July, AED) | Transaction View only | With invoices |
| --- | --- | --- |
| Gross sales (net proceeds 153,086.08 + shipping credits 5.00) | 153,091.08 | 153,091.08 |
| Other income (subsidies) | 12,192.62 | 12,192.62 |
| Marketplace fees | −25,244.52 (VAT inside) | −24,439.79 |
| Fulfillment | −24,206.36 (VAT inside) | −22,972.46 |
| Advertising | −4,392.20 (VAT inside) | −4,183.05 |
| Input VAT on fees | — | −2,247.78 |
| Output VAT on sales | — | −7,051.28 |
| Contribution | Incomplete (fee VAT not separated) | Recoverable **113,688.40** · Non-recoverable **111,440.62** · Unknown: incomplete |

3,189 Transaction View lines and 999 invoice lines, none unrecognised; 132
lines are counted under review (the medium-confidence codes above).

**Against the owner's own July workings** (gross 153,086; referral −24,999;
fulfilment −22,996; subsidies +11,873; advertising + balance transfer −5,111;
contribution 111,613): those used fee amounts including VAT, set 50 unattributed
rows aside and counted the balance transfer with advertising. BizMind counts
every row, takes stated VAT out of fees, and keeps the balance transfer as cash
under review. Each difference can be checked line by line on the dashboard.

## 5. Code and tests

| Path | Role |
| --- | --- |
| `src/services/marketplaces/noon/adapter.ts` | Detection of both formats; dispatch |
| `src/services/marketplaces/noon/transaction-view.ts` | Transaction View reader |
| `src/services/marketplaces/noon/invoices.ts` | Invoices reader; the columns never stored |
| `src/services/marketplaces/noon/rules.ts` | The 61 rules (import and classification) |
| `src/services/marketplaces/noon/values.ts` | Exact decimals, dates, sign changes (text only) |

- `npm run test:noon` — offline, in `npm run verify`: detection, every line
  type, VAT separation signs, stripped identity columns, rule consistency and
  parity with migration 0034.
- `npm run test:noon-ledger` — live, invented files: fee VAT not separated
  until the invoices arrive, the VAT settings, classifying an unknown code,
  overlap refusal on upload and restore, the combined AED view, isolation.
- `npm run test:noon-acceptance -- <tv.csv> <invoices.csv>` — live, the owner's
  real files, local only.
