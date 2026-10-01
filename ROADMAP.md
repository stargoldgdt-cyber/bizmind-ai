# Roadmap — GCC Marketplace Profit Intelligence

**Approved 2026-09-15.** The design every phase builds to is
[ARCHITECTURE_BASELINE.md](ARCHITECTURE_BASELINE.md). The roadmap that built
the platform underneath (phases 0–12) is archived as
[ROADMAP_LEGACY.md](ROADMAP_LEGACY.md).

Each phase depends on the one before it, and each ends with figures checked
against a real file or a hand-worked dataset. noon follows the dashboard
(Phase 5); its sample files were supplied on 2026-09-15.

---

## 1. Phases

| Phase | Delivers | Done when | State |
| --- | --- | --- | --- |
| **1** | Ledger foundation: marketplaces, accounts, tax profiles, source files, source rows, mapping rules, ledger, settlements, payouts; immutability; one writer; withdrawal; adapter contract; customer-data filter. **No parser, no UI** | Live tests prove isolation, immutability, the one writer, duplicates, withdrawal/restore, currency, blanks, customer data, lineage | ✅ Built and verified live, 2026-09-15 ([LEDGER.md](LEDGER.md)) |
| **2** | Amazon Flat File V2 adapter; rejection of other Amazon reports; marketplace accounts screen; upload flow with format detection; Data Sources shows ledger files | July Amazon figures reproduced or every difference explained; B2, B3, B8 answered | ✅ Built and verified live, 2026-09-15: July reproduced exactly from four real settlements ([AMAZON.md](AMAZON.md)) |
| **3** | Automatic classification + P&L engine (Amazon): the four-layer model; rules gain type, category, subcategory, treatment and confidence; the 21 Amazon rules restated; classification at calculation time; per-account VAT setting (B1); Data Quality issues (unknown, under review, VAT unknown, totals mismatch, row errors); Gross Sales, Net Sales, Marketplace Fees, Fulfillment, Advertising, Other Income and Contribution, each Final or Incomplete | July Amazon matches Phase 2; contribution incomplete while fee VAT is Unknown, 36,552.76 when Recoverable, 36,432.97 when Not recoverable; an invented unknown fee shows Incomplete and becomes Final after a rule is added, without re-upload | ✅ Built and verified live, 2026-09-16: all three July VAT outcomes reproduced from the real files; 51 engine checks |
| **4** | Live dashboard + validation view: account and month filters; figures with Final / Incomplete status; category → subcategory breakdown; drill-down to source lines; Data Quality page; marketplace-reported totals alongside; CSV export of the validation view; owner/admin classification of Unknown codes (B2 amended) | The owner loads the July Amazon files and uses the dashboard | ✅ Built and verified live, 2026-09-17 (`/ledger`); the owner's own check is pending |
| **5** | noon adapter: Transaction View + Invoices & Credit Notes, classified automatically; SAR contract as its own account; "NA" read as blank; buyer details stripped; overlapping exports refused; all accounts in one currency added up | July noon figures on the dashboard; B4, B5 answered | ✅ Built and verified live, 2026-09-17 ([NOON.md](NOON.md)). B4 answered except balance transfers (cash, under review); B5 keeps its default |
| — | **Owner validation**, from Phase 4 onward: compare Sales, Fees, Fulfillment, Advertising, Refunds, VAT, Payouts and Profit with the marketplace reports; each mismatch becomes a rule correction | Reported mismatches corrected | Continuous |
| **6** | Product master, SKU aliases + suggester + confirmation queue, dated COGS, product/SKU/category P&L | Gross Profit Final; cross-marketplace model checks reproduced; B7, B16 answered | ✅ Built and verified live, 2026-09-17 (migration 0035, 59 live checks). B16 decided, B7 kept, B17 default recorded. Gross Profit is Final once SKUs are matched and costs entered; the owner's cross-marketplace model checks wait for real costs (entered on screen, or via Phase 7 Sheets) |
| **7** | Expense refactor + categories; Google Sheets dataset targets (COGS, product master, operating expenses; optional advertising, bank); schedule | Net Profit Final; existing expense tab keeps syncing; Sheets live suite green; B12, B14 answered | ✅ Built and verified live, 2026-09-17 (migrations 0036–0038; 35 new live checks; Sheets suite 204 green). Expenses classified automatically, Net Profit per currency, Products and Product-cost tabs. B12 and B14 keep their defaults. Optional advertising is an expense category; the bank tab moves to Phase 8 with bank transactions; SKU suggestions from Sheets are not built (suggestions come from BizMind) |
| **8** | Bank accounts + statement import, payouts, matcher, reconciliation, cashflow; money flow, report catalogue, XLSX and Google Sheets export | Every reconciliation status produced by a fixture month; write-scope test green; B9 answered | ✅ Built and verified live, 2026-09-17 (migrations 0039–0040; 22 + 29 live checks; write-scope test 31 offline). **Owner decision:** no bank source exists — each settlement's reported total (noon: each reported payment) is the *expected* marketplace payout; *actual bank receipt* stays Not connected. Reconciliation is marketplace-side (adds up / does not / no total / marketplace payment). Report catalogue with Excel and Google Sheets export. B9 deferred until a bank source is connected; bank import and matcher not built |
| **9** | AI intents over verified queries; alerts on ledger metrics | Guard + intent suites; live model check | ✅ Built and verified, 2026-09-17 (migration 0041). Six fixed ledger questions (`/ledger/ask`) with new guards against "received" and "final" claims (intent suite 31 offline; `npm run ai:check-ledger`: 2 of 2 real answers passed). Nine ledger alert metrics per currency; not-final figures are skipped with their reasons (22 live checks; legacy automation suite 47 green) |
| — | **Home dashboard on the ledger** (`/overview`): headline figures with change against last month, waterfall, daily trend, cost breakdown, accounts, expected payouts, data health, products, observations | Readers agree with the P&L engine live; sign-in lands on it | ✅ Built and verified live, 2026-09-18 (migration 0043; 41 live checks, 33 offline). The legacy dashboard stays at `/dashboard` until Phase 10 |
| — | **SKU setup** (Products and costs): identical SKUs matched automatically, Needs attention with inline Save & Match, one Excel sheet for batches, product side panel, SKU summary per upload | Known SKUs never return to the queue; costs follow the product with dated history | Built 2026-09-18 (migration 0045) |
| — | **Executive dashboard** (the whole business at a glance): Month / 3 months / Year to date / 12 months, marketplace cards, month-by-month trend by marketplace; legacy screens hidden from the menu | Every monthly and account figure equals the P&L engine live | Built 2026-09-21 (migrations 0049–0051; 55 live checks) |
| — | **Website** for marketplace sellers: landing page rewritten, Privacy Policy and Terms drafted | Owner confirms prices and company details; lawyer reviews the legal texts | Built 2026-09-21; waiting on prices, company details and legal review |
| 10 | Legacy retirement: freeze old writers, drop deprecated tables, purge legacy customer PII | No reads found; backup taken; owner approval; B10 answered | — |

## 2. Open decisions

See [ARCHITECTURE_BASELINE.md §B](ARCHITECTURE_BASELINE.md). B6 and B11 were
resolved on 2026-09-15 and are implemented in Phase 1. B2, B3 and B8 were
answered in Phase 2, and B1 before Phase 3 (DECISIONS.md, 2026-09-15). B2 was
amended, and B15 (take rate) and B16 (Gross Profit) opened, the same day. B16
was decided on 2026-09-17 (Phase 6), and B17 (refunds and COGS) recorded with
its default.

### Known issue, to fix later (owner, 2026-09-18): VAT inside Amazon fees

The commission lines in Amazon.ae settlements include 5% VAT. The owner's
February 2026 invoice matches the settlement exactly on its VAT-included
column:
- Sales Commission: 212.38
- Refund Commission: 9.60, 1.87, 5.02 and 4.60

The rules from 0031/0032 count the whole commission as the fee.
- **Effect:** while VAT on fees is Recoverable, Amazon fees are overstated by
  about 4.8% of commission, and contribution is understated. This applies to
  every Amazon month, July included (its confirmed 36,552.76 will rise).
- **SP 360:** the Paid Services Fee is already flagged (0044).
- **FBA fees:** not yet checked against an invoice.

**Planned fix:**
1. Flag the Amazon commission and refund commission rules
   `amount_includes_vat`, as noon's are and as 0044 does. After that, months
   read "not final" until VAT is separated.
2. Add an Amazon VAT invoice (PDF) import. It takes the VAT out of fees and
   into input VAT, exactly as noon's Invoices and Credit Notes do.

The settlement already holds these amounts, so the invoice must never add
fee lines. That would double count them.

## 3. Manual steps for the owner

1. ~~Apply migrations 0029–0042~~ — done (0042 on 2026-09-17).
1c. **Add the marketplace starter alerts** you want under **Automations**, and
   change their thresholds to what would actually worry you.
1a. **Place any expense categories BizMind lists** under **Operating
   expenses**, so Net Profit can become final.
1b. **Enter products and costs** under **Products and costs**, and match
   marketplace SKUs under **SKU matching**, so July Gross Profit can become
   final and be checked against your own model.
2. ~~Supply a bank statement~~ — the owner has none for this workflow
   (2026-09-17). Connect a real bank source later to see actual receipts.
2a. **Try one Google Sheets export** from **Reports** once Google is
   connected: the real Google round trip is not covered by the automated tests.
3. **Confirm with an accountant** that VAT on each account's marketplace fees
   is recoverable, before setting it in BizMind (B1 is decided; the per-account
   setting is the accountant's confirmation). Set it under **Marketplace
   accounts → VAT on fees**; until then contribution shows as incomplete.
4. **Ask Carrefour seller support** which platform and exports exist (B13).
5. **Publish the Google OAuth app** before real sellers connect a sheet
   (testing-mode sign-ins expire after 7 days).
6. **Set `CRON_SECRET` and the schedule** at deployment (sync and alerts).
7. **Re-enable "Confirm email" in Supabase** before real customers.
8. **Validate the live dashboard** against your marketplace reports from Phase 4
   onward, and report every mismatch. Open it at **Marketplaces → Marketplace
   profit**; **Export for checking** downloads a CSV to compare.

## 4. What stays true from the legacy phases

Tenant isolation enforced in the database; money as exact text, never
arithmetic in TypeScript; blank is unknown, never zero; a similar name creates
a question, never a fact; the AI explains figures it was given and never states
one it was not; the integration engine and the Google Sheets transport; rule-
based alerts that never fire from a data gap.

## 5. What must not happen

- No ledger row updated, deleted, or written outside `ledger_apply_file()`.
- No customer name, email, phone or address in any new table.
- No automatic SKU merge; no allocation of marketplace-level costs to products (V1).
- No currency conversion (V1); no invented VAT treatment.
- No two-way Google Sheets sync (V1); writes only to exports BizMind created.
- No marketplace parser built on an assumed format: Amazon on Flat File V2,
  noon on real samples, Carrefour on verified capability.
- No legacy table dropped before a release proves nothing reads it.
