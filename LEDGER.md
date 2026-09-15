# The financial ledger

**Phase 1 of the GCC Marketplace Profit Intelligence rebuild.** Migrations
0029 and 0030. The approved design is
[ARCHITECTURE_BASELINE.md](ARCHITECTURE_BASELINE.md).

Phase 1 built the foundation only: tables, rules, the one writer, withdrawal,
the adapter contract and the customer-data filter. **There is no marketplace
parser, no screen and no report yet.** Amazon arrives in Phase 2.

---

## 1. What the ledger is

One row in `financial_transactions` for every amount a marketplace (or, later,
a bank) reported. It is the financial source of truth (decision A6). Every
figure BizMind shows from Phase 3 onwards is computed from it in SQL.

```
upload  →  adapter (pure TypeScript)  →  payload  →  ledger_apply_file()
                                                        │
                    import_batches (the file: fingerprint, format, account)
                    source_rows    (every row, as text, customer data removed)
                    settlements    (what the marketplace says it settled)
                    payouts        (what the marketplace says it paid)
                    financial_transactions (one row per amount)
                    import_issues  (rows that could not be read)
```

A figure traces back without a join to guess:
`financial_transactions` → `source_row_id` → `source_rows.raw` →
`source_file_id` → `import_batches` (file name, SHA-256, format, adapter
version, who, when).

## 2. The rules, and where each is enforced

| Rule | Enforced by |
| --- | --- |
| Ledger rows are never updated | `ledger_immutable_guard()` trigger raises on every UPDATE, for every role including the service role |
| Ledger rows are never deleted directly | The same trigger. The only exception is deleting the whole business (the parent row is gone when the cascade arrives, the 0006 technique) |
| Nothing is truncated | Statement triggers and `revoke truncate` |
| One writer | INSERT requires a transaction-local flag that only `ledger_apply_file()` (and withdraw/restore for the file record) sets. Signed-in users have `SELECT` only; even the service role is refused by the trigger |
| Every row has lineage | `source_row_id` and `source_file_id` are `NOT NULL`, and a composite foreign key `(business_id, source_file_id, source_row_id)` requires the source row to belong to that file **and** that business |
| Tenant isolation | RLS enabled and forced on every table; composite foreign keys `(business_id, …)` on every reference, so a row cannot point into another business even through a bug |
| Currency belongs to the account | The writer refuses any settlement, payout or transaction whose currency differs from `marketplace_accounts.currency`. The account's currency locks once a file references it |
| Blank is unknown | Source values are text or JSON null. Optional money and dates stay NULL. A blank **amount** cannot be a transaction: the adapter must record it as a row issue |
| Money is exact | Amounts arrive as decimal text (`^-?[0-9]{1,16}(\.[0-9]{1,4})?$`); a JSON number, a thousands separator or a fifth decimal place is refused. Views return money as text |
| Nothing silently dropped | The writer refuses a file in which any source row is not used by a transaction, settlement, payout or row issue |
| Classification comes from rules | A transaction without a mapping rule must be `UNMAPPED`; one with a rule must match the rule's side, category, subcategory, attribution and quantity rule exactly, and the rule must be ACTIVE for that marketplace and format |
| No customer data | See §5 |

## 3. Permissions (decision B11)

| Action | Roles |
| --- | --- |
| Read accounts, files, rows, ledger, settlements, payouts | Any member |
| Import a ledger file (`ledger_apply_file`) | OWNER, ADMIN, STAFF |
| Withdraw / restore a ledger file | OWNER, ADMIN |
| Create or change a marketplace account, change a tax profile | OWNER |
| Confirm SKU mappings, manage COGS and expenses | OWNER, ADMIN (Phases 4-5) |
| Reconciliation confirmations | OWNER (Phase 6) |
| VIEWER | Read only |

Every function checks membership first and answers "could not be found" for
another business's account or file, identically to an id that does not exist.

## 4. Duplicates, withdrawal and restore

- **The same file again** (same SHA-256, same account, not withdrawn) returns
  the existing file with `duplicate: true` and writes nothing. A partial unique
  index enforces it under concurrency as well.
- **The same settlement in a different file** is refused, naming the file that
  already counts it (decision B8).
- **Withdraw** (`ledger_file_withdraw`) stamps the file. Its lines, settlements
  and payouts leave `ledger_lines`, `ledger_settlements` and `ledger_payouts`.
  **No row is deleted:** the evidence stays queryable in the base tables, and
  the audit log records the counts and per-category totals.
- **Restore** (`ledger_file_restore`) brings them back, unless an identical
  file or one of its settlements is already counting from another file. The
  owner must withdraw that one first. Nothing is ever double counted.
- **Correcting a file** means withdrawing it and applying the corrected file.
  A new mapping rule version applies only to files applied after it exists.
- The legacy withdrawal functions (0027) refuse a ledger file; the guard
  trigger stops them before anything changes.

## 5. Customer data (decision A14)

Buyer name, email, phone and address never enter `source_rows` or the ledger.
Two barriers, with the same patterns in both:

1. **At the adaptation boundary** (`src/services/marketplaces/customer-data.ts`):
   a row keeps only its format's allowed columns, and any column that looks
   like customer data is dropped even if a format wrongly allows it. The
   registry refuses such a format outright. Dropped column **names** are
   recorded in `import_batches.stripped_columns`; values never are.
2. **In the database**: `source_rows.raw` must pass `ledger_raw_is_clean()`
   (no customer-data column name, no email address anywhere, text-or-null
   values only), and every ledger text field, settlement id, payout reference,
   issue message and file name is checked for email addresses.

A pattern can recognise a customer column and an email address. It cannot
recognise a person's name typed into a free-text description. The real
protection is structural: formats allow-list their columns, and no ledger table
has a column for a customer.

## 6. The payload

Built by `buildLedgerFilePayload()` in `src/services/marketplaces/ledger-file.ts`,
which applies the customer-data filter and checks the same rules first, so a
problem is reported in words before a request is made. The database trusts
none of it.

| Key | Contents |
| --- | --- |
| `marketplace_account_id` | The account. The business is derived from it |
| `format_id`, `adapter_version` | Recorded on the file |
| `file_name`, `file_type` (`csv`/`xlsx`), `file_size_bytes`, `file_sha256` | The file's identity (the bytes are not kept, decision B6) |
| `source_kind` | `UPLOAD` (default) or `API` |
| `columns`, `stripped_columns` | Header names only |
| `rows[]` | `{ row_number, raw }`: raw is an object of text or null |
| `settlements[]` | `{ external_settlement_id, source_row_number, period_start, period_end, reported_total, reported_deposit_date, currency }` |
| `payouts[]` | `{ key, source_row_number, external_ref, amount, currency, paid_at, settlement_ref }` |
| `transactions[]` | `{ source_row_number, line_index, mapping_rule_id, side, category, subcategory, source_type, source_subtype, source_description, amount, currency, posted_at, order_ref, order_line_ref, raw_sku, quantity, quantity_basis, attribution, settlement_ref, payout_ref }` |
| `issues[]` | `{ row_number, severity, field, message, raw_value }` |

Timestamps must carry a time zone. At most 50,000 rows per file.

## 7. Categories

| Side | Categories | Counts in |
| --- | --- | --- |
| `PNL` | REVENUE, REFUND, MARKETPLACE_FEE, FULFILMENT, PROMOTION, SUBSIDY, ADVERTISING, REIMBURSEMENT, OTHER_INCOME, OTHER_COST | Profit & loss |
| `CASH` | PAYOUT, RESERVE_HOLD, RESERVE_RELEASE, BALANCE_CARRIED, TRANSFER | Cashflow only, never revenue |
| `TAX` | OUTPUT_VAT, FEE_VAT, OTHER_TAX | The tax ledger, never revenue. `FEE_VAT` is input VAT on marketplace fees: out of P&L when the account's treatment is recoverable, a separate expense line when not recoverable; while unknown, P&L contribution is incomplete and a warning names the amount (B1) |
| `MEMO` | SETTLEMENT_TOTAL, INFORMATIONAL | No totals |
| (none) | `UNMAPPED` | No totals; always reported with its amount |

## 8. Code

| Path | Role |
| --- | --- |
| `src/services/marketplaces/contract.ts` | Adapter contract and draft types |
| `src/services/marketplaces/registry.ts` | Registry |
| `src/services/marketplaces/adapters.ts` | The application's adapters: Amazon Flat File V2 ([AMAZON.md](AMAZON.md)) |
| `src/services/marketplaces/amazon/` | The Amazon adapter |
| `src/services/marketplaces/customer-data.ts` | The customer-data filter |
| `src/services/marketplaces/ledger-file.ts` | Payload builder |
| `src/services/marketplaces/apply.ts` | Server-only door: the three RPCs, through the user's session |
| `src/services/datasets/contract.ts` | The boundary Google Sheets datasets will write through (Phase 5) |

## 9. Tests

- `npm run test:marketplaces` (offline, part of `npm run verify`): only the
  approved adapters registered, registry refusals, the customer-data filter, SQL/TypeScript pattern
  parity, the payload builder, the dataset boundary, and that no new module can
  reach around the database.
- `npm run test:ledger` (live, against Supabase): isolation, immutability for
  every role including the service role, the one writer, duplicates, currency,
  blank values, customer data, lineage, rule matching, withdrawal and restore,
  cross-tenant refusal, and that deleting a business still works through the
  immutable tables.
- Amazon suites: see [AMAZON.md §5](AMAZON.md).

## 10. Reversibility

Migration 0030 is additive: every existing import becomes `dataset = LEGACY`
and nothing else changes. `supabase/rollback/0030_marketplace_ledger_foundation.rollback.sql`
removes everything 0030 added, and refuses to run while any ledger file or
marketplace account exists. 0029's enum value cannot be removed (PostgreSQL has
no way to), and is harmless unused.
