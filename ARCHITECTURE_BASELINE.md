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
| B2 | Who approves a fee-mapping rule (DECISIONS.md, 2026-09-09, "A source column is not a metric…") | Built-in versioned rules with evidence; new codes stay UNMAPPED; no business overrides in V1 — **Resolved 2026-09-15 (Phase 2):** GLOBAL rules approved by the owner, seeded by migration, `SAMPLE_VERIFIED` against real files |
| B3 | Amazon: Premium Services Fee, Tax lines, reserve lines | Provisional rules, labelled — **Resolved 2026-09-15:** Premium Services Fee is SP 360, a marketplace fee; Tax on fee is TAX·FEE_VAT; COD charge is other income; no tax-on-sales or reserve lines seen (they would arrive UNMAPPED) |
| B4 | Noon mappings, `balance_transfer`, invoices/credit notes | No noon adapter |
| B5 | Is a noon fee line joined to a single-SKU order "reliable attribution"? | No, order level |
| ~~B6~~ | **Resolved 2026-09-15:** fingerprint + parsed source rows; original files not kept; no buyer PII in source rows | — |
| B7 | COGS for sales before the first cost entry | Cost unknown; explicit audited backfill only |
| B8 | Same settlement id, different content | Refused, naming the file already counting it — **Kept as decided 2026-09-15** |
| B9 | Reconciliation tolerance and date window | Exact amount, ±7 days, editable |
| B10 | When legacy customer PII is purged | At legacy retirement |
| ~~B11~~ | **Resolved 2026-09-15:** Viewer read-only; Staff import only; Admin import + SKU mappings + COGS + expenses; Owner everything incl. integrations, reconciliation, configuration | — |
| B12 | Sheets change notifications in V1 | Schedule + Sync now only |
| B13 | Carrefour capability | Contract only |
| B14 | Existing orders, sheets, expenses | Orders read-only legacy; expenses/products carry over; no conversion to ledger rows |

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
| `settlements`, `payouts` | 1 ✅ | Immutable (manual payouts voidable, Phase 6) |
| `products` (refactor), `sku_aliases`, `sku_alias_rejections`, `product_costs` | 4 | Confirmed aliases only; dated costs |
| `expenses` (refactor), `expense_categories`, `adjustments` | 5 | Adjustments native, immutable |
| `bank_accounts`, `bank_transactions`, `reconciliations`, `reconciliation_links` | 6 | Suggested, confirmed by a person |
| `quality_issues`, `report_exports` | 3 / 7 | Never deleted; exports append-only |

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

## D. Phases

See [ROADMAP.md](ROADMAP.md). Phase 1 details: [LEDGER.md](LEDGER.md).

## E. Deferred beyond V1

Two-way Sheets sync; marketplace API connectors; the Carrefour adapter until
verified; FX conversion; VAT accounting; SKU-level allocation of marketplace
fees and ads; FIFO or weighted-average COGS; ad campaign performance; cashflow
risk alerts; email/push notifications; business-level mapping overrides; bank
API feeds; customer analytics and the health score; Shopify; converting legacy
orders into ledger rows.
