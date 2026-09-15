# Roadmap — GCC Marketplace Profit Intelligence

**Approved 2026-09-15.** The design every phase builds to is
[ARCHITECTURE_BASELINE.md](ARCHITECTURE_BASELINE.md). The roadmap that built
the platform underneath (phases 0–12) is archived as
[ROADMAP_LEGACY.md](ROADMAP_LEGACY.md).

Each phase depends on the one before it, and each ends with figures checked
against a real file or a hand-worked dataset. Noon joins whenever real sample
files arrive, any time after Phase 3.

---

## 1. Phases

| Phase | Delivers | Done when | State |
| --- | --- | --- | --- |
| **1** | Ledger foundation: marketplaces, accounts, tax profiles, source files, source rows, mapping rules, ledger, settlements, payouts; immutability; one writer; withdrawal; adapter contract; customer-data filter. **No parser, no UI** | Live tests prove isolation, immutability, the one writer, duplicates, withdrawal/restore, currency, blanks, customer data, lineage | ✅ Built and verified live, 2026-09-15 ([LEDGER.md](LEDGER.md)) |
| **2** | Amazon Flat File V2 adapter; rejection of other Amazon reports; marketplace accounts screen; upload flow with format detection; Data Sources shows ledger files | July Amazon figures reproduced or every difference explained; B2, B3, B8 answered | ✅ Built and verified live, 2026-09-15: July reproduced exactly from four real settlements ([AMAZON.md](AMAZON.md)) |
| 3 | P&L engine (marketplace + combined), fee breakdown, refund analysis, data-quality checks | Hand-worked dataset suite | — |
| 4 | Product master, SKU aliases + suggester + confirmation queue, dated COGS, product/SKU/category P&L | Cross-marketplace model checks reproduced; B7 answered | — |
| 5 | Expense refactor + categories; Google Sheets dataset targets (COGS, product master, operating expenses; optional advertising, bank); schedule | Existing expense tab keeps syncing; Sheets live suite green; B12, B14 answered | — |
| 6 | Bank accounts + statement import, payouts, matcher, reconciliation, cashflow | Every reconciliation status produced by a fixture month; B9 answered | — |
| 7 | Dashboard, money flow, report catalogue, CSV/XLSX export, Google Sheets export | Every figure drills to a source row; write-scope test green | — |
| 8 | AI intents over verified queries; alerts on ledger metrics | Guard + intent suites; live model check | — |
| N | noon adapter | July noon figures reproduced; B4, B5 answered | Blocked on sample files |
| 10 | Legacy retirement: freeze old writers, drop deprecated tables, purge legacy customer PII | No reads found; backup taken; owner approval; B10 answered | — |

## 2. Open decisions

See [ARCHITECTURE_BASELINE.md §B](ARCHITECTURE_BASELINE.md). B6 and B11 were
resolved on 2026-09-15 and are implemented in Phase 1. B2, B3 and B8 were
answered in Phase 2 (DECISIONS.md, 2026-09-15).

## 3. Manual steps for the owner

1. ~~Apply migrations 0029, 0030 and 0031~~ — done 2026-09-15.
2. **Supply sample files:** a noon Transaction View, noon invoices / credit
   notes, one bank statement. (Amazon settlements: supplied and used, Phase 2.)
3. **Ask an accountant** about VAT treatment (B1) before Phase 3 sign-off.
4. **Ask Carrefour seller support** which platform and exports exist (B13).
5. **Publish the Google OAuth app** before real sellers connect a sheet
   (testing-mode sign-ins expire after 7 days).
6. **Set `CRON_SECRET` and the schedule** at deployment (sync and alerts).
7. **Re-enable "Confirm email" in Supabase** before real customers.

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
