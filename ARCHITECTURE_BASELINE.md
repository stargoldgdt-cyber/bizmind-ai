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
| A11 | VAT architecture configurable; no accounting treatment before an accountant confirms it |
| A12 | Currency belongs to the marketplace account. No FX conversion in V1 |
| A13 | WooCommerce is hidden and deprecated, not deleted |
| A14 | No customer name, email, phone or address in the new core model or the ledger |
| A15 | Carrefour: no Mirakl assumption; adapter contract only until capability is verified |
| A16 | Amazon: build against Flat File V2 (`GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`). The old summary report is never a financial source |
| A17 | Noon: no final mapping until the real Transaction View and Invoice/Credit Note samples are supplied |

## B. Open decisions

| # | Question | Default until decided |
| --- | --- | --- |
| B1 | VAT treatment in P&L (UAE 5%, KSA 15%) | Tax lines kept apart and excluded from profit, with a "not confirmed" banner |
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
| `marketplaces`, `marketplace_accounts`, `tax_profiles` | 1 ✅ | Currency on the account; tax UNCONFIGURED |
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

## D. Phases

See [ROADMAP.md](ROADMAP.md). Phase 1 details: [LEDGER.md](LEDGER.md).

## E. Deferred beyond V1

Two-way Sheets sync; marketplace API connectors; the Carrefour adapter until
verified; FX conversion; VAT accounting; SKU-level allocation of marketplace
fees and ads; FIFO or weighted-average COGS; ad campaign performance; cashflow
risk alerts; email/push notifications; business-level mapping overrides; bank
API feeds; customer analytics and the health score; Shopify; converting legacy
orders into ledger rows.
