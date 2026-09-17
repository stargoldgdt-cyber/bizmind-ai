# Architecture baseline — GCC Marketplace Profit Intelligence

**Approved by the owner on 2026-09-15 (v1.0).** This file is the repository
copy of the approved baseline, so every future session builds to the same
decisions. The full document, with the audit, schema cards and mapping tables,
is the private artifact "BizMind GCC Architecture Audit", version 2.

Where this file and an older document disagree, this file wins.

---

## A. Locked decisions

| # | Decision |
| --- | --- |
| A1 | BizMind is a **GCC Marketplace Profit Intelligence Platform**. Not an ERP, not a traditional accounting system |
| A2 | The Google Sheets connector stays. Its transport is kept: OAuth, Picker, reading, paging, fingerprints, retries, sync history, tenant isolation |
| A3 | The Sheets target layer moves away from the old ERP entities |
| A4 | Sheets is an optional data layer. V1: COGS, Product Master, Operating Expenses. Optional: Advertising, Bank Transactions. SKU mapping from Sheets only creates suggestions. Manual adjustments are native only |
| A5 | Sheets write access only for BizMind-generated exports. No two-way sync in V1 |
| A6 | The immutable line-level ledger is the financial source of truth |
| A7 | Marketplace-level fees and advertising without reliable SKU attribution stay at marketplace level in V1. No artificial allocation to products |
| A8 | COGS: one "COGS / Unit" field in the UI; dated historical versions in the backend |
| A9 | Settlement, payout and bank deposit are separate entities, linked only by reconciliation |
| A10 | SKU mapping: UNMAPPED → SUGGESTED → CONFIRMED / REJECTED. Never an automatic merge on normalised similarity |
| A11 | VAT architecture configurable; no accounting treatment before an accountant confirms it. The P&L treatment of VAT on marketplace fees is decided in B1 (2026-09-15) |
| A12 | Currency belongs to the marketplace account. No FX conversion in V1 |
| A13 | WooCommerce is hidden and deprecated, not deleted |
| A14 | No customer name, email, phone or address in the new core model or the ledger |
| A15 | Carrefour: no Mirakl assumption; adapter contract only until capability is verified |
| A16 | Amazon: build against Flat File V2 (`GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`). The old summary report is never a financial source |
| A17 | Noon: no final mapping until the real Transaction View and Invoice/Credit Note samples are supplied |

## B. Open decisions

| # | Question | Default until decided |
| --- | --- | --- |
| ~~B1~~ | **Resolved 2026-09-15:** VAT on marketplace fees (UAE 5%, KSA 15%) is not a P&L expense when it is recoverable as input VAT; it stays on the tax ledger. Non-recoverable VAT is a separate expense line. While the treatment is Unknown, P&L contribution is incomplete (never shown as final) and a data-quality warning names the amount. See §C "VAT on marketplace fees" and DECISIONS.md | — |
| B2 | Who approves a fee-mapping rule (DECISIONS.md, 2026-09-09, "A source column is not a metric…") | Built-in versioned rules with evidence; new codes stay UNMAPPED; no business overrides in V1 — **Resolved 2026-09-15 (Phase 2):** GLOBAL rules approved by the owner, seeded by migration, `SAMPLE_VERIFIED` against real files — **Amended 2026-09-15:** an owner or admin may classify an Unknown code for their own business (audited; never overriding a high-confidence BizMind rule) |
| B3 | Amazon: Premium Services Fee, Tax lines, reserve lines | Provisional rules, labelled — **Resolved 2026-09-15:** Premium Services Fee is SP 360, a marketplace fee; Tax on fee is TAX·FEE_VAT; COD charge is other income; no tax-on-sales or reserve lines seen (they would arrive UNMAPPED) |
| B4 | Noon mappings, `balance_transfer`, invoices/credit notes | No noon adapter — **Resolved 2026-09-17 (Phase 5):** mappings built from the real files (NOON.md); invoices supply fee VAT and output VAT; `balance_transfer` is Cash / Transfer under review until its purpose is confirmed |
| B5 | Is a noon fee line joined to a single-SKU order "reliable attribution"? | No, order level |
| ~~B6~~ | **Resolved 2026-09-15:** fingerprint + parsed source rows; original files not kept; no buyer PII in source rows | — |
| B7 | COGS for sales before the first cost entry | Cost unknown; explicit audited backfill only — **Kept 2026-09-17 (Phase 6):** a sale with no cost in force on its date keeps Gross Profit incomplete; a back-dated cost entry is the audited backfill |
| B8 | Same settlement id, different content | Refused, naming the file already counting it — **Kept as decided 2026-09-15** |
| B9 | Reconciliation tolerance and date window | Exact amount, ±7 days, editable — **Deferred 2026-09-17 (Phase 8):** applies only once a bank source is connected; none exists yet |
| B10 | When legacy customer PII is purged | At legacy retirement |
| ~~B11~~ | **Resolved 2026-09-15:** Viewer read-only; Staff import only; Admin import + SKU mappings + COGS + expenses; Owner everything incl. integrations, reconciliation, configuration | — |
| B12 | Sheets change notifications in V1 | Schedule + Sync now only — **Kept 2026-09-17 (Phase 7)** for the new Products and Product-cost tabs too |
| B13 | Carrefour capability | Contract only |
| B14 | Existing orders, sheets, expenses | Orders read-only legacy; expenses/products carry over; no conversion to ledger rows — **Kept 2026-09-17 (Phase 7):** the `expenses` table, uploads and synced expense tabs are unchanged and are classified at calculation time; legacy Products tabs keep writing legacy `products` |
| B18 | Do expense amounts include recoverable VAT? | Taken as entered: the owner records expenses net of any VAT they reclaim. BizMind does not split VAT out of expenses |
| B15 | Marketplace take rate definition | Not defined and not shown. The historical 19.1% could not be reproduced exactly from the July files (DECISIONS.md) |
| ~~B16~~ | **Resolved 2026-09-17:** Gross Profit = Contribution (net sales − marketplace fees − fulfilment − advertising) − COGS; Net Profit = Gross Profit − operating expenses (Phase 7). Built in Phase 6 | — |
| B17 | Does a refund give back the unit's COGS? | No (V1): the returned stock's condition is not known. COGS counts units sold only |

## C. The model, in one screen

```
Source → Transport → Adapter (pure) → ledger_apply_file() → Source rows → Ledger → Engines
                                                              settlements · payouts
Google Sheets → dataset targets → products · product_costs · expenses · bank_transactions · sku_aliases (suggested)
```

| Entity | Phase | Rule |
| --- | --- | --- |
| `marketplaces`, `marketplace_accounts`, `tax_profiles` | 1 ✅ | Currency on the account; tax UNCONFIGURED (fee-VAT recoverability added in Phase 3, B1) |
| `import_batches` (source files) | 1 ✅ | SHA-256, format, adapter version, stripped column names |
| `source_rows` | 1 ✅ | Immutable, text, no customer data |
| `ledger_mapping_rules` | 1 ✅ | Versioned data; never edited |
| `financial_transactions` | 1 ✅ | Immutable; one writer; composite-key lineage |
| `classification_categories`, `classification_rules`, `tax_profiles.input_vat_treatment` | 3 ✅ | The model; versioned rules applied at calculation time; the account's VAT setting (B1) |
| `settlements`, `payouts` | 1 ✅ | Immutable (manual payouts voidable, Phase 6) |
| `catalog_products`, `sku_aliases` (confirmed and rejected decisions), `product_costs` | 6 ✅ | Confirmed matches only, suggestions computed; dated, append-only costs; COGS and Gross Profit at calculation time (migration 0035). Legacy `products` stays until Phase 10 |
| `expenses` (unchanged), `expense_categories`, `expense_category_rules` | 7 ✅ | Classified at calculation time; unknown names keep Net Profit incomplete (migration 0037). `adjustments` not built |
| `bank_accounts`, `bank_transactions`, `reconciliations`, `reconciliation_links` | later | Not built: the owner has no bank source (2026-09-17). Expected payouts (`expected_payouts()`, 0039) are read from settlements and reported payments; actual bank receipt is NOT_CONNECTED |
| `report_exports` | 8 ✅ | Google Sheets exports; the created spreadsheet is recorded once, never repointed (0040). `quality_issues` stays computed (`ledger_data_quality()`) |

Ledger sides: `PNL`, `CASH` (never revenue), `TAX` (separate), `MEMO`, plus
`UNMAPPED` lines that count nowhere and are always reported.

### Six views of money, never merged

| View | Answers | Holds |
| --- | --- | --- |
| **P&L** | Economic profit and cost | `PNL` lines, plus non-recoverable VAT (B1) |
| **Tax ledger** | VAT charged and input VAT | `TAX` lines, including recoverable and unknown VAT on fees |
| **Cashflow** | Actual cash movement | Bank transactions and `CASH` lines (Phase 6) |
| **Settlement** | What the marketplace calculated | `settlements` and the lines in them |
| **Payout** | What the marketplace says it paid | `payouts` |
| **Bank** | What actually arrived | `bank_transactions` (Phase 6) |

A figure belongs to exactly one view. Links between views are made only by
reconciliation (A9), never by adding one view's numbers into another's.

### VAT on marketplace fees (B1)

Marketplace service fees may carry VAT: 5% in the UAE, 15% in Saudi Arabia.
BizMind records the VAT amount **the marketplace reports**; it never works VAT
out from a rate.

| Fee VAT treatment (per marketplace account) | P&L | Tax ledger | Shown to the owner |
| --- | --- | --- | --- |
| **Recoverable** as input VAT through the company's VAT return | Excluded. Not a marketplace cost, operating expense or advertising expense; never revenue | Input VAT | Input VAT |
| **Not recoverable** | An expense, on its own line (not folded into the fee) | Kept for traceability | Non-recoverable VAT |
| **Unknown** (the default) | Not added as an expense and not treated as zero. **P&L contribution is incomplete: no final figure is shown** | Held as VAT with unknown treatment | "VAT treatment unknown: <currency> <amount>" and a data-quality warning. The contribution may appear only as an informational "Contribution before fee-VAT treatment", never labelled as final P&L contribution |

The treatment is configuration on the account's tax profile, set by the owner
once their accountant confirms it (A11). It is not inferred from VAT
registration, the country or the rate. Ledger lines never change when the
treatment changes; the P&L reads the treatment when it is calculated.

Example, July 2026 Amazon.ae (AED 119.79 VAT on the SP 360 fee):

| Account's fee-VAT treatment | Final P&L contribution | Shown |
| --- | --- | --- |
| Unknown | None — incomplete | Warning "VAT treatment unknown: AED 119.79"; informational "Contribution before fee-VAT treatment: AED 36,552.76" |
| Recoverable | AED 36,552.76 | No warning; AED 119.79 on the tax ledger as input VAT |
| Not recoverable | AED 36,432.97 | AED 119.79 as a separate non-recoverable VAT expense line |

### Automatic classification (approved 2026-09-15)

Sellers never classify normal marketplace lines. The marketplace adapter and its
rules classify every known line automatically; people handle exceptions only.

```
Upload → detect marketplace + format → read rows, strip customer data
→ store source lines unchanged → match each line to a rule
→ Financial Type → Category → Subcategory → P&L Treatment
→ metrics, each Final or Incomplete
```

**Four layers**

| Financial Type | Categories | Default P&L Treatment |
| --- | --- | --- |
| Revenue | Product Sales, Shipping Income | Increase Revenue (these make up Gross Sales) |
| Revenue | Other Income, Reimbursement, Subsidy / Promotion Income | Increase Revenue (not Gross Sales) |
| Revenue | Sales Refunds & Returns, Seller-funded Discounts | Decrease Revenue |
| Expense | Marketplace Fee, Fulfillment / Logistics, Storage, Advertising, Payment / COD Fee, Refund Fee, Penalty, Other Marketplace Expense | Increase Expense |
| Tax | Input VAT | Conditional on the account's VAT setting: Recoverable → No P&L Impact; Non-recoverable → Increase Expense; Unknown → P&L incomplete (B1) |
| Tax | Output VAT | No P&L Impact |
| Cash | Payout, Reserve Hold, Reserve Release, Transfer | No P&L Impact |
| Memo | Report Total, Report Result, Informational | No P&L Impact (cross-checks only) |

The subcategory keeps the marketplace's own detail (Referral Commission, FBN
Outbound, SP 360, …). The treatment belongs to the category; the amount's sign
carries reversals. "Conditional" is used only for a stored account setting,
never for an unanswered question.

- A reversal keeps the category of what it reverses.
- Refunds of sales reduce revenue; they are not expenses.
- Payouts are Cash, never revenue.
- Non-recoverable VAT stays Tax / Input VAT; its treatment makes it an expense.
- Marketplace-reported totals and results (Net Sale, fee totals, Payment
  totals, Profit/Loss) are Memo cross-checks, never lines.
- Percentages and text labels are not money and are never imported.
- Seller cost data (such as Wholesale Price) is COGS input, not a marketplace line.

**What lives where**

| Place | Holds |
| --- | --- |
| Adapter code, one per report format | Detection, parsing, which columns are money, row → lines, match keys, customer-data removal, where the currency comes from, whether VAT is reported separately |
| Classification rules, versioned data | Match key → type, category, subcategory, treatment, confidence, evidence |
| Shared model, one for every marketplace | Types, categories, default treatments, metric definitions |
| Marketplace account | Currency, VAT setting |

Matching is deterministic: descriptions are normalised (case, spacing,
statement and document prefixes), then matched to exact keys. Pattern rules
are written by BizMind and are Medium confidence at most. AI never decides where
money is counted; it may later draft a rule that a person approves.

**Confidence and exceptions**

| Situation | File | Line counts | What the seller sees |
| --- | --- | --- | --- |
| High-confidence rule | Imported | Yes | Nothing |
| Medium-confidence rule | Imported | Yes | "Under review"; the figure notes the lines under review |
| No rule (new code) | Imported | No | Unknown in Data Quality with code, amount and lines; affected figures Incomplete by that amount |
| Input VAT while the account's VAT setting is Unknown | Imported | Conditional | Contribution Incomplete, with the VAT amount |
| Unreadable row | Imported (rest of file) | No | Row error; affected figures Incomplete |
| Marketplace totals differ from the lines | Imported | Yes | Warning with both amounts |
| Wrong or unsupported report, wrong marketplace, currency mismatch, customer data that cannot be removed, changed settlement (B8) | Refused | — | Message saying what to upload instead |

A figure is **Final** only when no Unknown line, unresolved Conditional line or
unreadable row affects it. Otherwise it is **Incomplete**, with the exact amount
and reason — never zero, never estimated. One unknown line never blocks a file.

**Classification at calculation time.** Ledger lines keep the marketplace's facts
and are never edited. Metrics classify each line through the active rule version
when they are calculated. A correction retires a rule version and adds a new
one; every later calculation, for every period, uses it without a re-upload.
Before a correction applies, BizMind shows its effect (for example "moves
AED 1,472.00 from Unknown to Fulfillment in July"), and the audit log records
it. The side and category stored on a ledger line in Phases 1–2 remain the
import-time record.

**Who corrects a rule.** BizMind, globally for every seller; or, for an Unknown
code only, an owner or admin for their own business — audited, and never
overriding a high-confidence BizMind rule (B2, amended).

**Validation.** Once the dashboard is live, the owner compares BizMind's figures
with the marketplace reports. Each mismatch becomes a rule correction.

**As built (Phase 3, migration 0032).** Classification rules are their own
versioned table, separate from the import rules that decide quantity and
attribution. A line's match key is its three source codes joined with "|".
Rule precedence: a HIGH BizMind rule, then the business's own, then a MEDIUM
BizMind rule. Amounts keep the marketplace's sign from the seller's view, so
every figure is a signed sum and reversals net off. Periods are half-open on
`posted_at`, in UTC; one row per marketplace account, never across currencies.
Readers: `pnl_summary()`, `pnl_breakdown()`, `ledger_data_quality()`.

**The screens (Phase 4, migration 0033).** `/ledger` (Marketplace profit: account
and month filters, headline figures with Final/Incomplete, the statement, VAT
apart from profit, the category breakdown, each settlement's reported total
beside its lines and payout, CSV export), `/ledger/lines` (the lines behind any
figure) and `/ledger/quality` (the exception path, including classifying an
unknown code after previewing its effect, and undoing it). They sit beside
the legacy `/dashboard`, `/profit` and `/data-quality` until Phase 10.

**noon (Phase 5, migration 0034).** Where a marketplace reports fees including
VAT and states the VAT only on its invoices, the fee rules carry
`amount_includes_vat` and the invoice lines `separates_included_vat`: each
invoice line takes the stated VAT back out of the fee's category and records
it as Input VAT. Until that happens in a period, contribution is incomplete
(`FEE_VAT_NOT_SEPARATED`) unless the account's VAT setting is Non-recoverable.
Any ledger file that repeats a row already counted for its account is
refused, on upload and on restore. `pnl_summary()` can add up every account
in one currency; the dashboard offers it as "All <currency> accounts".

## D. Phases

See [ROADMAP.md](ROADMAP.md). Phase 1 details: [LEDGER.md](LEDGER.md).

## E. Deferred beyond V1

Two-way Sheets sync; marketplace API connectors; the Carrefour adapter until
verified; FX conversion; VAT accounting; SKU-level allocation of marketplace
fees and ads; FIFO or weighted-average COGS; ad campaign performance; cashflow
risk alerts; email/push notifications; business-level mapping overrides; bank
API feeds; customer analytics and the health score; Shopify; converting legacy
orders into ledger rows.
