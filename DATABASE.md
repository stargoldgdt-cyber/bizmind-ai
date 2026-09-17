# Database

PostgreSQL, hosted by Supabase. This document covers the schema, how tenant
isolation is enforced, and how to apply changes.

---

## 1. The rule everything else follows

**Business A must never see Business B's data, and that is enforced by the
database — not by application code.**

Row Level Security is switched on for every table. If a query in the
application forgets to scope itself, PostgreSQL still refuses to return another
business's rows. Application-side scoping is a second layer, never the only
one.

Practical consequences:

- A table without RLS policies is a bug, not an oversight. Policies are written
  in the **same migration** that creates the table.
- The **service-role key bypasses RLS entirely.** It is never used to serve a
  user request and never reaches the browser. Background jobs only.
- Never trust a `business_id` sent by the client. Derive it from the session,
  or verify membership server-side before using it.

---

## 2. Current schema

Two migrations, 15 tables.

| Migration | Adds |
| --- | --- |
| `0001_identity_and_tenancy.sql` | profiles, businesses, business_members |
| `0002_universal_data_model.sql` | channels, customers, products, product_variants, inventory, inventory_movements, orders, order_items, payments, returns, expenses, audit_logs |
| `0003_dashboard_metrics.sql` | `dashboard_summary()`, `channel_performance()` |
| `0004_import_pipeline.sql` | import_batches, import_issues, `import_apply_*()` |
| `0005_historical_cost_stability.sql` | Removes the catalogue-cost backfill; adds `order_items.cost_missing` |
| `0006_allow_business_deletion.sql` | Lets a business actually be deleted; the last-owner guard was blocking its own cascade |

**Not yet built, by design:** integration and sync tables (Phases 9-12), AI
tables (Phase 8), automation tables (Phase 13). Each is designed when its
phase arrives, informed by real requirements rather than guessed at now.

```
auth.users                      managed by Supabase, we never write to it
    │  (trigger on signup)
    ▼
profiles                        our copy of who someone is
    │
    ▼
business_members ──────────►  businesses
  role: OWNER | ADMIN            the tenant
        STAFF | VIEWER
```

### profiles

Application-visible mirror of `auth.users`. Created automatically by the
`handle_new_user()` trigger when someone signs up.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | references `auth.users(id)`, cascade delete |
| `email` | text | |
| `full_name` | text | from signup metadata |
| `avatar_url` | text | |
| `created_at` / `updated_at` | timestamptz | `updated_at` maintained by trigger |

### businesses — the tenant

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `name` | text | 1–120 characters |
| `slug` | text UNIQUE | URL-safe, generated from the name |
| `currency` | char(3) | ISO 4217. All figures for this business report in it |
| `timezone` | text | |
| `created_by` | uuid | references `profiles(id)`, `on delete restrict` |

`on delete restrict` is deliberate: deleting a person must not silently delete
the business they created.

### business_members — who may see what

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `business_id` | uuid | cascade delete |
| `user_id` | uuid | cascade delete |
| `role` | `business_role` | VIEWER < STAFF < ADMIN < OWNER |

Unique on `(business_id, user_id)` — one membership per person per business.

**This table is the authority for tenant access.** Every RLS policy in the
product resolves through it.

---

## 2b. The universal data model

> **Legacy model (2026-09-15).** Marketplace figures come from the immutable ledger
> (§7l, [LEDGER.md](LEDGER.md)). These tables keep working until legacy retirement.

The vendor-neutral shape every integration normalises into. Shopify,
WooCommerce, a CSV and a manual entry all land here, so analytics and AI never
learn what "Shopify" is.

```
channels ──┐
           ├──► orders ──► order_items ──► product_variants ──► products
customers ─┘      │                              │
                  ├──► payments                  └──► inventory
                  └──► returns                          │
                                              inventory_movements
expenses          (standalone)
audit_logs        (cross-cutting, append-only)
```

### Money and quantities

Every money and quantity column is **`numeric(20,4)`**. Never `float` or
`double`: binary floating point cannot represent `0.10` exactly, and the error
compounds across aggregation. `numeric` is exact decimal arithmetic.

### How a money figure reaches the application (migration 0011)

**Money crosses the boundary as exact decimal text, and the cast happens in
SQL.**

```
numeric(20,4)  →  ::text in SQL  →  {"revenue":"9007199254740993.0000"}  →  string
     exact            lossless              quoted, full scale               exact
```

`numeric::text` is lossless in PostgreSQL: it writes the stored decimal digits,
full scale included. Because the value is already a string when it reaches
`JSON.parse`, nothing narrows it to a double. `Money = string` is therefore
**true at runtime**, and true because the database says so.

#### What this replaced, and why

Until 2026-09-09 this document claimed PostgREST returned numerics as JSON
strings. It did not. Probing the live database showed unquoted numbers —
`{"revenue":0.1000,"cogs":0.30000000}` — which `JSON.parse` narrowed to
IEEE-754 doubles. The declared type was a lie and the safety it promised did
not exist.

Converting after the fact (`String(Number(value))`) would have been theatre:
the precision is gone by then. The cast had to happen while the value was still
exact, which is why it happens in SQL.

#### The shape of it

| Layer | Holds |
| --- | --- |
| `analytics_core` schema | The exact-numeric implementations. **Not exposed through PostgREST** |
| `public` wrappers | The same figures, cast to `text`. The only contract application code can reach |

Three functions (`analytics_financials`, `analytics_channels`,
`analytics_products`) were **moved** into `analytics_core` with
`ALTER FUNCTION … SET SCHEMA`, so their arithmetic was carried across verbatim
rather than retyped. The three that build on them
(`analytics_compare`, `analytics_reconciliation`, `analytics_health_inputs`)
read exact numerics from `analytics_core`, do their arithmetic in SQL as
before, and cast only their own output.

The wrappers are `SECURITY INVOKER`. Making them `DEFINER` would have avoided
granting EXECUTE on the inner functions and would also have bypassed Row Level
Security, which is never worth a convenience.

#### Counts are not money

`orders_count`, `items_total`, `customers_count` and friends stay `bigint` and
arrive as JavaScript numbers. They are exact integers far below 2^53 and are
declared `number`, so that declaration is already true. Casting them would make
the types lie in the other direction.

#### NULL still means unknown

`null::numeric::text` is NULL, which PostgREST emits as JSON null. A figure the
database could not calculate arrives as `null` — never `"0"`, never `""`,
never `0`.

#### What the type does NOT do

It does not prevent arithmetic. `a + b` on two strings compiles and returns
`"10002000"`. Nothing in the type system stops that, and this document used to
imply otherwise.

What prevents it is `scripts/verify-money-guard.ts`, which scans the source for
arithmetic on a money-named field and fails the build. Ordering goes through
`compareMoney` in `src/services/analytics/money.ts`, which compares digits and
converts nothing.

`scripts/verify-money-boundary.mts` proves the whole path against the live
database using 9007199254740993 — 2^53+1, the smallest integer a double cannot
hold. If any step converts it, the value becomes …992 and the suite fails.

#### One known inconsistency

`dashboard_summary()` and `channel_performance()` from migration 0003 still
return `numeric`. Nothing in the application calls them — a test asserts that —
and they were left alone rather than widening this change. They must be cast if
they are ever used.

Quantities are numeric rather than integer because goods sell by weight and
volume as well as by the piece.

### Decisions worth knowing

**`order_items.unit_cost` is the cost AT THE TIME OF SALE.** Using today's cost
to compute a past month's profit produces a wrong number that looks entirely
plausible — the most dangerous kind of error in this product. The same applies
to `sku` and `name`, copied onto the line so a renamed or deleted product does
not corrupt order history.

**Nothing ever copies a catalogue cost into an order line.** Migration 0004
originally did, and migration 0005 removed it: a supplier re-pricing a product
would silently rewrite last year's profit, and two people running the same
report months apart would get different answers. A line with no cost keeps
`unit_cost` null and is marked `cost_missing`, so the dashboard reports the gap
instead of filling it with a number that was never true. Migration 0005
verifies its own work and refuses to commit if the backfill reappears.

Any future "backfill historical costs" feature must be explicit: confirmed by
the user, previewing how many lines change and the financial impact, written to
`audit_logs`, and never automatic.

**`orders.fee_total` is a first-class column**, not lumped into expenses.
Marketplace commission is usually the whole answer to "why does Amazon revenue
convert to so much less profit than the website?", which is the product's
central question.

**`inventory.quantity_on_hand` may go negative.** Overselling is a real event
the owner needs to see, not something to hide behind a constraint.

**Idempotent sync.** Rows that originate externally carry `source` and
`external_id`, with a unique index on `(business_id, source, external_id)`, so
re-importing an order updates it rather than duplicating it. Each such table
also has a `..._external_needs_source` check constraint requiring `source`
whenever `external_id` is set — in a unique index NULL never equals NULL, so
without it two rows with a null source would not collide and the guarantee
would silently vanish.

**`audit_logs` is append-only.** There is no INSERT, UPDATE or DELETE policy at
all. Entries are written by `write_audit_log()`, which stamps the actor from
the session so it cannot be forged. Verified: not even an OWNER can edit or
delete an entry.

### Policy generation

The eleven operational tables get their policies from a loop in section 12 of
migration 0002 rather than forty hand-written statements. This is deliberate:
near-identical hand-written policies invite a typo that silently leaves one
table unprotected. Uniformity matters more than verbosity for a security
boundary, and section 13 then verifies the result and rolls the whole migration
back if anything is missing.

Each of the eleven gets exactly four policies:

| Command | Allowed to |
| --- | --- |
| SELECT | any member of the business |
| INSERT | OWNER, ADMIN, STAFF |
| UPDATE | OWNER, ADMIN, STAFF |
| DELETE | OWNER, ADMIN |

`audit_logs` gets one SELECT policy, restricted to OWNER and ADMIN.

---

## 3. Indexes

| Index | Why |
| --- | --- |
| `business_members(user_id)` | The hot path. Every RLS check resolves the caller's businesses through this column |
| `business_members(business_id)` | Member lists, role checks |
| `businesses(created_by)` | Ownership lookups |
| `businesses(slug)` | Created automatically by the UNIQUE constraint |
| `orders(business_id, placed_at desc)` | The workhorse. Nearly every analytics query is "this business, this date range, newest first" |
| `orders(business_id, channel_id, placed_at desc)` | Channel profitability |
| `order_items(order_id)` | Expanding an order into its lines |
| `expenses(business_id, incurred_at desc)` | Expense trends and anomaly detection |
| `inventory_movements(variant_id, occurred_at desc)` | Reconstructing stock history |
| `customers(business_id, lower(email))` | Deduplicating buyers across channels |
| `audit_logs(business_id, created_at desc)` | Reading the trail |

Every synced table also carries a partial unique index on
`(business_id, source, external_id)` that makes re-imports idempotent.

---

## 4. Helper functions

Every RLS policy is built from these. They are `SECURITY DEFINER`, which means
they run with the definer's privileges and so bypass RLS internally.

**Why that is necessary, not lazy:** an RLS policy on `business_members` that
itself queries `business_members` causes infinite recursion — Postgres cannot
evaluate the policy without first evaluating the policy. Doing the lookup
inside a definer function breaks the cycle.

**Why it is safe:** each function only ever reveals facts about the *calling*
user's own memberships. None of them accept a user id to impersonate.

| Function | Returns |
| --- | --- |
| `current_user_business_ids()` | Every business the caller belongs to |
| `current_user_has_role(business_id, roles[])` | Whether the caller holds one of those roles there |
| `shares_business_with_current_user(user_id)` | Whether the caller shares any business with that person |
| `create_business(name, slug, currency, timezone)` | Creates a business **and** the owner membership atomically |

Every function sets `search_path = ''`, so a malicious schema on the caller's
search path cannot shadow the tables they reference. That is why every object
inside them is fully qualified (`public.business_members`, not
`business_members`).

### Why `create_business()` exists

Creating a business and becoming its owner must be **one transaction**. If they
were separate statements, a failure between them would leave a business with no
owner — unadministrable and invisible to everyone. A function body is a single
transaction, so it cannot half-succeed.

This is why `businesses` has **no INSERT policy**. The function is the only
supported way to create one.

---

## 5. RLS policies

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `profiles` | self or teammate | — (trigger) | self only | — (cascade) |
| `businesses` | members | — (use `create_business`) | OWNER, ADMIN | OWNER |
| `business_members` | same business | OWNER, ADMIN | OWNER, ADMIN | OWNER, ADMIN, or self |

Members may delete their own row — that is "leave this business".

`FORCE ROW LEVEL SECURITY` is set on all three tables. Without it, a
table-owner connection silently bypasses its own policies.

### Integrity trigger

`prevent_last_owner_removal()` blocks deleting or demoting the final OWNER of a
business. Without it an owner could lock everyone out of their own workspace,
including themselves.

It ignores cascades from a business being deleted. A cascade removes the parent
row before its members, so the business's absence is what distinguishes
"someone is leaving" from "the whole workspace is going". Without that check the
trigger blocked its own cascade and no business could ever be deleted, even
though the DELETE policy allowed it — fixed in migration 0006. The lesson: a
policy existing is not evidence that the operation works. Test the behaviour.

### Privileges

RLS filters rows; `GRANT` decides who may run a query at all. Both matter.
`anon` is explicitly revoked on all three tables — an anonymous visitor has no
business touching them.

---

## 6. Applying migrations

Migrations live in `supabase/migrations/`, numbered and applied in order. They
are **append-only**: never edit one that has already run, because other
environments have applied the old version. Write a new migration instead.

**To apply a migration:**

1. Open your project at <https://supabase.com/dashboard>
2. Click **SQL Editor** in the left sidebar
3. Click **New query**
4. Paste the entire contents of the migration file
5. Click **Run**

Expected result: `Success. No rows returned`.

Migrations are written to be run once. Re-running `0001` will fail on
`create type ... business_role` because the type already exists — that error
means it was already applied, not that something is broken.

---

## 7. Verifying isolation

After any change to policies, confirm isolation still holds. In the SQL Editor:

```sql
-- Should list your tables with rowsecurity = true
select tablename, rowsecurity
from pg_tables
where schemaname = 'public';

-- Should list every policy
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
order by tablename, cmd;
```

The real test is behavioural: sign in as two users in two different businesses
and confirm neither can see the other's rows. Add that check whenever a new
business-owned table is introduced.

### Isolation results — 2026-09-08, migration 0001

Two accounts in two separate businesses. Every request below was made with a
genuine signed-in user token, not a crafted one.

| Attempt (user A against business B) | Result |
| --- | --- |
| List all businesses | Saw only its own |
| Read B's business by exact id | 0 rows |
| Read B's `business_members` | 0 rows |
| Update B's business name | 0 rows changed; B's data confirmed intact afterwards |
| Delete B's business | 0 rows deleted; B's business still present |
| Insert self into B as OWNER | Refused — `42501 new row violates row-level security policy` |
| List all profiles | Saw only its own |
| Reverse direction (B against A) | Saw only its own |

Last-owner protection, verified separately:

| Attempt | Result |
| --- | --- |
| Owner demotes self to VIEWER | Refused — `P0001 A business must always have at least one owner.` |
| Owner deletes own membership row | Refused — same |

Note the difference between the read and write failures. Reads return **empty
results**, not errors: RLS filters rows rather than announcing that something
was hidden, so an attacker cannot use error messages to confirm a record
exists. Writes are refused outright.

### Isolation results — 2026-09-08, migration 0002 (all 12 new tables)

Business A was loaded with real commerce data — a customer, a product and
variant with costs, stock, an Amazon order with line items, a payment and an
expense — then attacked from Business B.

| Attempt | Result |
| --- | --- |
| Read each of the 12 tables unfiltered | 0 rows on every one |
| Read A's order, order line, variant cost, customer PII, payment, expense and stock **by exact id** | 0 rows on every one |
| Update A's order total / variant cost / stock level | **0 rows affected** |
| Delete A's order / expense / customer | **0 rows affected** |
| Insert a row into A's expenses or orders | Refused — `42501 new row violates row-level security policy` |
| Insert directly into `audit_logs` | Refused — no INSERT privilege exists |

Verified afterwards **from A's own session** that the order, variant cost,
stock level and customer were all unchanged. A "204 No Content" response to a
cross-tenant UPDATE is not proof of failure on its own; re-running with
`Prefer: return=representation` confirmed **0 rows** were touched.

Control test: B could freely insert and update within its own business, so the
policies are not simply blocking everything.

### Role model — verified

B was added to Business A as a VIEWER, then removed.

| Attempt as VIEWER | Result |
| --- | --- |
| Read A's orders | Allowed — 1 order visible |
| Insert an expense into A | Refused — `42501` |
| Update A's order | 0 rows affected |
| Promote self to OWNER | 0 rows affected |
| After removal, read A's orders | 0 rows — access revoked immediately |

Note the difference between an INSERT and an UPDATE failure. An INSERT is
refused with an error because it violates the `WITH CHECK` clause; an UPDATE
simply matches no rows, because `USING` filters them out first. Both are
correct, and both leave the data untouched.

### Audit log — verified append-only

| Attempt as OWNER | Result |
| --- | --- |
| Write via `write_audit_log()` | Succeeded, actor stamped from the session |
| UPDATE the entry | Refused — no UPDATE privilege |
| DELETE the entry | Refused — no DELETE privilege |

**Even a business owner cannot alter the audit trail.** That is the point.

Re-run these whenever policies change.

---

## 7b. Source truth (migration 0008)

Two tables exist so BizMind can hold a supplier's or marketplace's own figures
**without claiming to understand them**.

### source_records

One row per record as the source stated it: the raw figures in a `jsonb`
column, plus two columns that carry what would otherwise be lost.

| Column | Why it exists |
| --- | --- |
| `figures` | Every value the file gave, verbatim, as exact decimal text |
| `blank_fields` | Which columns were **blank**, so blank stays distinguishable from a recorded zero |
| `checks` | The reconciliations that were run and whether each passed |

A row that fails its own reconciliation is **stored with the failure recorded**.
It is never corrected. If a marketplace's totals do not add up, the owner needs
to know that, not to be shown a tidied version.

### source_field_semantics

A column in someone else's report is not a BizMind metric. This table is the
gate between the two, and it is enforced by database constraints rather than
application code:

```sql
constraint semantics_mapping_requires_confirmation
  check (maps_to is null or status = 'CONFIRMED'),
constraint semantics_confirmation_requires_attribution
  check (status <> 'CONFIRMED' or (confirmed_by is not null and confirmed_at is not null))
```

In plain terms: **a field nobody has confirmed cannot feed a BizMind figure,
and a confirmation must carry a name and a timestamp.** No code path can skip
this, because it is not a code path.

Confirming goes through `confirm_source_field_semantics()`, which is restricted
to OWNER and ADMIN and writes an audit entry naming the field, the metric, and
the person.

### Blank is not zero

Migration 0008 made these columns nullable, having previously defaulted them
to `0`: `orders.{subtotal, discount_total, tax_total, shipping_total,
fee_total}` and `order_items.{unit_price, discount, tax, line_total}`.

A default of zero was a quiet lie. "This order had no marketplace fee" and
"the file did not say what the fee was" are different facts, and only the first
one is safe to subtract from profit. Analytics now reports
`orders_fees_unknown` and `fee_coverage` so the gap is visible on the
dashboard instead of being silently absorbed into a better-looking margin.

`npm run test:source-truth` proves both properties against the live database.

---

## 7c. Canonical field mapping (migration 0009)

Full explanation in [MAPPING.md](MAPPING.md). What the schema does:

### canonical_metrics

BizMind's own vocabulary, shared by every tenant, so it carries no
`business_id`. Readable by any signed-in user and writable by none.

Each metric has an `origin`:

- `sourced` — a confirmed source column may supply it
- `computed` — BizMind calculates it, and **no source may supply it**

The definitions in plain language live in `src/services/metrics/canonical.ts`
and are deliberately not copied here; prose in two places drifts. This table is
what a constraint can act on. `npm run test:mapping-data` asserts the two agree.

### Candidate and mapping are different columns

`source_field_semantics` gains `candidate_metric` alongside `maps_to`:

| Column | What it is | Who writes it |
| --- | --- | --- |
| `candidate_metric` | What BizMind **suspects** | A name-matching rule |
| `maps_to` | What BizMind is **permitted to use** | Only a person |

Analytics never reads the first. A suggestion cannot be promoted by accident,
because it is not stored in the same place as a permission.

Both columns are constrained by a foreign key onto `canonical_metrics` paired
with a pinned `'sourced'` value, so **a source column can never be mapped to a
computed metric** — not to gross profit, net profit, a margin, or a coverage
figure. A marketplace's own "Profit/Loss" column is structurally unable to
occupy BizMind's net profit.

### Statuses

`mapping_status` replaces migration 0008's `semantics_status`. Existing
`UNVERIFIED` rows became `PENDING_CONFIRMATION`, which is what they meant.

`SUGGESTED` · `PENDING_CONFIRMATION` · `CONFIRMED` · `REJECTED` · `UNKNOWN`

`UNKNOWN` is a real answer: somebody looked and does not know. It stops the
same question being asked at every import.

### Profiles

`source_mapping_profiles` recognises a file **shape** by a normalised,
order-independent signature, so the same export is recognised next month.

`source_mapping_profile_fields` says which fields a profile covers — and stores
**no metric of its own**. Meaning is reached through `semantics_id`, behind the
constraints, so a profile cannot carry a mapping the gate would have refused.

A file that has gained a column produces a different signature and is not
recognised, so the new column gets asked about.

### Functions

| Function | Does |
| --- | --- |
| `suggest_source_field_semantics()` | Records a candidate. Cannot write `maps_to`, cannot write CONFIRMED |
| `confirm_source_field_semantics()` | Records a decision. OWNER/ADMIN only, audited |
| `save_mapping_profile()` | Saves a file shape and the fields it covers |
| `resolve_mapping_profile()` | Returns each field with a `usable` flag |
| `mapping_lineage()` | Where a number came from: metric, source, original column, who confirmed it, when |

All are `SECURITY INVOKER`, so RLS applies inside them.

---

## 7d. Automation and alerts (migrations 0016, 0017)

Full explanation in [AUTOMATION.md](AUTOMATION.md). What the schema does:

### canonical_metrics gains `analytics_key`

A rule targets a **canonical** metric — `marketplace_fees` — but the analytics
functions return a column called `fees`. The mapping already existed in
`src/services/metrics/canonical.ts` as `analyticsKey`; 0016 copies it here so a
rule can be resolved in SQL without asking the application.

`NULL` means the analytics engine does not publish that metric, so no rule can
fire on it. The evaluator records `NO_ANALYTICS_KEY` rather than treating the
absence as a comparison that failed.

### Three tables

| Table | Holds |
| --- | --- |
| `automation_rules` | Standing instructions: metric, operator, threshold, period |
| `automation_runs` | **Every** evaluation, including the ones that fired nothing |
| `alerts` | What fired, with the figure that fired it copied onto the row |

`automation_runs` is the one worth arguing for. A table of alerts records what
happened; only this records what *didn't*, and why — which is the question an
owner asks after something goes wrong.

### Evaluation is a database function

`automation_evaluate_rule(p_rule_id)` reads `analytics_financials()` (or
`analytics_compare()` for a percentage change), compares in SQL, writes a run
row, and raises an alert only if the comparison matched. Nothing is compared in
TypeScript, so an alert can never disagree with the dashboard.

It takes a **rule id, never a business id**: the tenant is read off the rule
row. That is the same trusted-resolution pattern the sync functions use, and it
is why the privileged path can refuse any call carrying a business id.

### The worker's claim crosses tenants; nothing else does

| Function | Security | Granted to |
| --- | --- | --- |
| `automation_claim_due()` | DEFINER | `service_role` **only** |
| `automation_evaluate_rule()` | DEFINER, membership-checked when a session exists | `authenticated`, `service_role` |
| `automation_evaluate_business()` | DEFINER, membership-checked | `authenticated` |
| `alert_acknowledge()` | INVOKER — RLS scopes it | `authenticated` |

`automation_claim_due()` answers "which rules are due?", which has no
per-business form. It returns nothing but rule IDs, and is deliberately absent
from `src/types/database.ts` so it cannot be reached from a session-scoped
client. Migration 0016 refuses to install if `authenticated` can execute it.

### Alerts carry their own operator (0017)

0016 copied metric, value, threshold and period onto each alert so it could be
read months later without depending on a rule that may since have changed. It
did not copy the **operator** — and without it a `CHANGE_PCT` alert on revenue
(a percentage) and a value alert on revenue (money) are indistinguishable on
the row. 0017 adds it, `NOT NULL`, and asserts that before committing.

### Policies

RLS is enabled **and forced** on all three tables. Four policies each: any
member reads; OWNER/ADMIN insert, update and delete rules; any member updates
an alert, because acknowledging is the job of whoever deals with it.

0016 revokes the Supabase default privileges from `anon` and `authenticated`
before granting anything back, and refuses to install if `anon` can still read
any of the three.

---

## 7e. The integration engine, repaired and extended (0018–0021)

**0018** — the sync write path never wrote a row: every sync and webhook batch
used `file_type = 'api'`, which the column's check refused. Fixed, and synced
orders now carry their connection's channel.

**0019** — enum values only, applied alone: PostgreSQL will not use a new enum
value inside the transaction that added it.

**0020** — engine changes:

| Change | Detail |
| --- | --- |
| `orders_number_key` | Now `(business_id, source, order_number)`. Order numbers repeat across sources, not within one. A pure relaxation |
| `sync_jobs.resource` | Accepts `EXPENSES`; `sync_apply_expenses()` added |
| `sync_jobs` | `next_trigger`, `rerun_requested` |
| `sync_runs` | `trigger`, `rows_inserted`, `rows_updated`, `rows_unchanged`, `rows_rejected` |
| `import_batches` | `integration_account_id`, `sync_run_id` — which connection and run a batch came from |
| `sync_job_complete()` | New `p_has_more`. The old signature was dropped first, because two overloads make every call ambiguous |
| `integration_account_connect()` | Creates a channel only when given a channel type |
| `integration_account_pause()` | Owner or admin. Resuming only turns `PAUSED` back into `CONNECTED` |
| `integration_account_set_state()` | Worker only. May never pause or disconnect |
| `sync_enqueue_system()` | Session-less queueing. Declines for paused, broken or dead-lettered connections |

**0021** — Google Sheets foundation:

| Table | Holds | Signed-in users |
| --- | --- | --- |
| `integration_watch_channels` | Google change-notification channels, which expire within a day | Read every column **except** `token_encrypted`, which is granted column by column so it can never be reached |
| `integration_record_state` | One fingerprint per business record per connection | Read only |

Both have RLS enabled and forced. Nobody signed in can write to either: they are
written only by service_role functions that take a job, account or channel id
and derive the tenant from it. A record missing from its source is marked
`present = false` — **never deleted**.

## 7f. One Google sign-in per business (0022)

| Change | Detail |
| --- | --- |
| `integrations.credentials_encrypted` | The business's sealed Google refresh token. Written only by the confined server-side writer |
| `integrations.authorized_by`, `authorized_at` | Who connected Google, and when |
| `integrations` privileges | All revoked from `anon` and `authenticated`, then granted back **column by column without the credential** — the same pattern as `integration_accounts`. `select *` is therefore refused |
| `sync_job_context()` | Returns the connection's own credential, or the business's when it has none |
| `integration_google_authorize()` | Owner or admin. Creates or refreshes the business's Google row, turns every `REAUTH_REQUIRED` sheet back to `CONNECTED`, writes an audit entry, and returns the row **with the credential blanked** |

## 7g. Applying a spreadsheet's rows (0023)

| Change | Detail |
| --- | --- |
| `sync_job_context()` | Also returns `business_currency`. Dropped and recreated: a new result column is a return-type change |
| `integration_record_state.last_seen_pass` | Which read-through last saw each record — an opaque id from the connector's cursor, compared for equality only. No clock is involved, so the app's and the database's clocks never have to agree |
| `sync_record_state_classify()` | New `p_pass_id`. Also returns `repeated`: records already seen earlier in this pass at a different place in the sheet |
| `sync_record_state_commit()` | New `p_pass_id`, stored on each record |
| `sync_record_state_mark_missing()` | New `p_pass_id`: "missing" means "not seen by that pass". The start-time form still works |
| `sync_record_issues()` | Records a sync page's row problems in `import_issues`. Takes a job id; a batch it is given must belong to that connection. With no batch (every changed row refused) it creates one marked `FAILED` |
| `sync_job_complete()` | **Fix.** Since 0012 it ignored a `DEAD_LETTER` from the worker and retried anyway — up to seven attempts over hours, for failures retrying cannot fix. It is now final |

The three record-state functions each gained a trailing parameter with a
default, so every existing call still works. Their old signatures were dropped
first — two overloads make every call by name ambiguous — and the migration
checks that each function exists exactly once. All are `service_role` only.

## 7h. Record lineage (0024)

Every order, product and expense now carries a history of what wrote it —
the foundation for withdrawing an import without touching anything another
source also owns.

| Piece | What it does |
| --- | --- |
| `record_lineage` | One row per record per batch that wrote it (`CREATED`, `UPDATED`, `RECOVERED`), plus `DIRECT` for an edit made outside any import and `UNTRACED` for a record whose origin cannot be proven. Members read it; **nobody writes it directly** — forged lineage could make another import's record look like this one's |
| Capture | `import_load_batch()`, which every import, sync and webhook write already calls first, tags the transaction with its batch. Triggers on `orders`, `products` and `expenses` record each write. An untagged write is `DIRECT` (once per record, and only when business data changed) |
| Withdrawal markers | `withdrawn_at`, `withdrawn_by_batch` on the three tables; `lineage_status`, `withdrawn_at`, `withdrawn_by`, `withdrawal_reason` on `import_batches`. **Nothing sets them yet.** Database triggers refuse any change except from the (coming) withdraw/restore functions; an import writing a record again clears them |
| `lineage_status` | `RECORDED` (captured as it ran) · `RECOVERED` (rebuilt from its stored rows) · `INCOMPLETE` (some rows had no identity — an expense with no Reference) · `NONE` (kept no rows: syncs, webhooks). Only `RECORDED` and `RECOVERED` imports can ever be withdrawn |
| `record_lineage_recover_batch()` | Rebuilds an older upload's lineage by exact key match (trimmed, same business and source). Never touches lineage recorded as an import ran. `service_role` only |

**The rule withdrawal will follow:** a record is withdrawn only if every write
to it came from the import being withdrawn, or from imports already withdrawn.
Any other import, sync, webhook, direct edit or `UNTRACED` origin makes it
shared, and it stays.

**Imports made before 0024** were traced in the migration. Anything that could
not be traced safely is `UNTRACED` — records no import claims, and records from
a source that a row-less sync or webhook also wrote to. The migration refuses
to install unless every existing record has at least one line of history.

**No figure changes in 0024.** The analytics readers start excluding withdrawn
records when they are rewritten for the channel dimension.

A future migration that must touch these three tables in bulk should set
`bizmind.lineage_writer = 'on'` for its transaction, or every record it touches
will gain a `DIRECT` line and become non-withdrawable.

## 7i. Analytics foundation (0025)

Four changes to the same functions, made once:

| Change | Detail |
| --- | --- |
| **Channel is a dimension** | `analytics_counted_orders()` takes `p_channel_id` (one channel) or `p_no_channel` (orders with no channel), and financials, channels, products, the comparison and reconciliation all pass it through. Three-argument calls still work: the new parameters default to "every channel" |
| **Expenses stay whole-business** | Under a channel filter `expenses`, `net_profit` and `net_margin` are NULL and `channel_scoped` is true. There is no per-channel expense data, so nothing is allocated. The dashboard reads net profit unfiltered and labels it "Whole business" |
| **Withdrawn records stop counting** | Every reader excludes orders, expenses, products (and their stock) whose `withdrawn_at` is set. Nothing sets it yet |
| **Products identified honestly** | Grouped by SKU, then linked product, then name; lines with none form one row, "Lines with no product identity". Named from the catalogue, then the order line, then the SKU; `name_source` says which. `product_key` is the stable row key. "(unnamed)" and the merged "(no SKU)" row are gone |
| **A blank line total is not zero** | A line's value is its line total, or CALCULATED as quantity x unit price, or unknown. Calculated value is reported separately (`line_revenue_derived`, `revenue_derived`, `items_value_derived`); the stored line is not changed. Unknown lines are left out of line revenue and product profit (`items_value_unknown`) instead of counting as zero. Headline revenue, cost of goods and channel figures are unaffected |

Business Health stays whole-business: stock, payments and customers are not
per channel.

The migration refuses to install unless every public analytics function has
exactly one signature and its grant, money is still text, and for existing
businesses the revenue of each channel plus orders with no channel adds up to
the whole. `npm run test:analytics-foundation` holds every figure to a
hand-worked dataset.

## 7j. Channel comparison and data quality (0026)

Three read-only functions, all `security invoker`, all taking the same window
and channel parameters as the rest of the analytics layer.

| Function | Answers |
| --- | --- |
| `analytics_channel_compare()` | Every channel side by side for a window and the one before it: revenue, its share of the whole (`revenue_share`), gross margin, orders, average order value, and the change against the previous window. Shares are computed in SQL so nothing divides money in a browser |
| `analytics_change_drivers()` | What moved the headline figure: each channel's contribution to the revenue change, as an amount and as a percentage of the total change, ordered by size. The answer to "why is this month down?" |
| `analytics_data_quality()` | One row per kind of gap — missing cost, no fee, no channel, no customer, unknown line value, no product lines — with how many orders it affects and what it does to the figures |
| `analytics_quality_orders()` | The orders behind one of those gaps, paged in the database |

A `full outer join` on `is not distinct from` is not hash- or merge-joinable in
PostgreSQL, so the channel comparison joins on `coalesce(channel_id,
'00000000-...'::uuid)` instead. Orders with no channel are a real row in the
comparison, not a footnote.

## 7k. Withdrawing an import (0027, 0028)

What 0024's lineage was built for. An owner can take an import back out of
their business data, and BizMind can say exactly what that will and will not
touch **before** anything happens.

| Function | What it does |
| --- | --- |
| `import_batch_overview()` | The Data Sources list: every import with its rows, added, updated, skipped, errors, warnings, how many records it wrote, how many it has withdrawn, its lineage status and its connection name. `security invoker`, so RLS decides what is listed |
| `import_batch_withdrawal_preview()` | What withdrawing would do: records written, created, updated, how many would stop counting, how many would stay because something else also wrote them, and **who those others are**. Read-only, and computed with the same rule the withdrawal applies, so a confirmation cannot promise something the action will not do |
| `import_batch_withdraw()` | Marks the records this import owns alone as withdrawn, marks the import, writes the audit log. Nothing is deleted |
| `import_batch_restore()` | Clears the markers this import set, and only those |

**Withdrawn, not deleted** (the owner's decision, 2026-09-12). The records stop
counting towards every figure — 0025's readers already exclude them — while the
import, its rows, its row problems and its lineage all remain, and it can be
restored.

**The rule.** A record is withdrawn only if every other write to it came from an
import that is itself already withdrawn. Any other active import, any sync, any
direct edit, or an `UNTRACED` origin makes it shared, and shared records are not
touched. Only `RECORDED` and `RECOVERED` imports can be withdrawn at all.

**What withdrawal cannot do.** A record this import UPDATED keeps the values it
wrote: BizMind keeps no earlier version of a record. The preview says so in
words, so nobody expects a rollback they are not getting.

**Security.** The three that read or change business data are `security
definer`, so they check for themselves: owner or admin, and a member of that
import's business. An import in a business the caller does not belong to is
refused with the same wording as one that does not exist, so a refusal cannot
confirm that someone else's import is real. The withdrawal markers are
otherwise unreachable — the 0024 triggers refuse any request that tries to set
them directly.

**0028 is a fix to 0027.** The preview returns a column called `entity` and
counted rows with an unqualified `entity = 'ORDER'`; inside plpgsql the output
column is also a variable, so PostgreSQL refused the query — at call time, not
at install time. 0027's self-verification checked privileges and source text and
passed; `npm run test:withdrawal` calls the functions for real, and found it on
the first run. Migration self-checks cannot replace calling the thing.

## 7l. Marketplace ledger foundation (0029, 0030)

GCC Phase 1. Full rules and the payload contract: [LEDGER.md](LEDGER.md).

| Object | What it is |
| --- | --- |
| `marketplaces` | AMAZON, NOON, CARREFOUR and each adapter's status. Reference data, read-only |
| `marketplace_accounts` | One store on one marketplace in one country; holds the currency, which locks once data exists |
| `tax_profiles` | One per account; treatment is `UNCONFIGURED` until an accountant confirms one |
| `import_batches` + 7 columns | `dataset` (LEGACY / LEDGER), `source_kind`, account, `format_id`, `adapter_version`, `file_sha256`, `stripped_columns`. Every existing row is LEGACY |
| `source_rows` | Every parsed row of a ledger file, text or null, no customer data. Immutable |
| `ledger_mapping_rules` | Marketplace codes → side/category, versioned data; only ACTIVE → RETIRED may change |
| `settlements`, `payouts` | What the marketplace reported settling and paying. Immutable |
| `financial_transactions` | The ledger. Immutable |
| `ledger_lines`, `ledger_settlements`, `ledger_payouts` | Invoker views: active files only, money as text |
| `ledger_apply_file()` | The only writer. OWNER/ADMIN/STAFF |
| `ledger_file_withdraw()` / `ledger_file_restore()` | OWNER/ADMIN. Withdrawal stamps the file; no row is deleted |
| `marketplace_account_create/update()`, `tax_profile_update()` | OWNER |

**Enforcement.** Triggers refuse every INSERT outside the writer (even for the
service role), every UPDATE, every direct DELETE and every TRUNCATE on the four
ledger tables; ledger file records and their row issues are guarded the same
way. Deleting a business cascades through all of it. Composite foreign keys
`(business_id, …)` on every reference. RLS enabled and forced; signed-in users
have SELECT only. The migration proves the writer rule by trying to break it.

**Additive.** Nothing existing changes meaning. Rollback:
`supabase/rollback/0030_marketplace_ledger_foundation.rollback.sql` (refuses
while any ledger file or account exists). 0029's enum value cannot be removed.

## 7m. Amazon Flat File V2 (0031)

GCC Phase 2. Details: [AMAZON.md](AMAZON.md).

| Change | What it does |
| --- | --- |
| `import_batches.file_type` | Adds `txt`; `ledger_apply_file()` accepts it (otherwise unchanged from 0030) |
| `ledger_mapping_rules` | 21 GLOBAL Amazon rules, `SAMPLE_VERIFIED`, owner-approved |
| `marketplaces` | AMAZON becomes `AVAILABLE` |
| `import_batch_overview()` | Recreated with `dataset`, `format_id`, account id/label/code and transaction, settlement, payout and unmapped counts; ledger files count ledger lines as records |
| `import_batch_withdrawal_preview()` | Refuses a ledger file (it has its own withdrawal) |
| `ledger_file_summary()` | Invoker. A file's lines per side/category/subcategory, exact totals as text |
| `ledger_file_settlements()` | Invoker. Each settlement's reported total, the sum of its lines, whether they match, and its reported payout |

No rollback script: to undo, set AMAZON back to `CONTRACT_ONLY` and retire the
rules; the reader functions are harmless unused.

## 7n. Automatic classification and the P&L engine (0032)

GCC Phase 3. The model and rules: ARCHITECTURE_BASELINE.md §C "Automatic
classification".

| Object | What it is |
| --- | --- |
| `classification_categories` | The 24 categories: financial type, default P&L treatment, the figure each adds into. A check refuses a treatment that does not fit the type. Reference data, read-only |
| `classification_rules` | Marketplace code → category + subcategory, HIGH or MEDIUM, versioned. GLOBAL rules come from migrations (21 for Amazon); BUSINESS rules only through `classification_rule_classify()`. Never edited; deleted only with the owning business |
| `classification_match_key()` | A line's key: `source_type\|source_subtype\|source_description`, blanks as empty strings |
| `tax_profiles.input_vat_treatment` | `UNKNOWN` (default), `RECOVERABLE`, `NON_RECOVERABLE`. Set by `tax_profile_set_input_vat()` (OWNER, audited) |
| `ledger_classified_lines` | Invoker view: every line of an active file with its classification resolved through the rules active now, and its effective treatment |
| `pnl_summary(from, to, account)` | Per account: gross sales, refunds, seller discounts, net sales, other income, marketplace fees, fulfillment, advertising, other costs, non-recoverable VAT, contribution (NULL unless FINAL), statuses and reasons. Exact text |
| `pnl_breakdown(from, to, account)` | Totals per type, category, subcategory and status; unknown lines named by their code |
| `ledger_data_quality(from, to, account)` | Unknown codes, lines under review, VAT setting unknown, row errors, settlement mismatches |
| `classification_rule_impact()` | Invoker. What classifying a code would move, per account and month |
| `classification_rule_classify()` / `classification_rule_retire()` | OWNER/ADMIN. Only for a code BizMind does not classify and that appears in the business's files; a correction retires the previous version. Audited |

All readers are SECURITY INVOKER; the writers check membership and role.
Ledger rows are untouched. Rollback:
`supabase/rollback/0032_classification_pnl_engine.rollback.sql` (refuses while
any business has classified its own codes).

## 7o. The ledger dashboard's readers (0033)

GCC Phase 4. Read-only, SECURITY INVOKER, closed to anon.

| Function | What it returns |
| --- | --- |
| `pnl_periods(business)` | The months (UTC) each account has lines in, with line counts |
| `pnl_settlements(from, to, account)` | Each settlement with a line in the period or a period overlapping it: reported total, the sum of all its lines, whether they match, the part posted in the period, and the reported payout |
| `ledger_data_quality(from, to, account, business)` | Recreated: optional business filter and the marketplace code on every item. Calls without the new argument behave as before |

Rollback: `supabase/rollback/0033_ledger_dashboard.rollback.sql` drops the two
new readers and keeps the compatible `ledger_data_quality()`.

## 7p. noon (0034)

GCC Phase 5. Details: [NOON.md](NOON.md).

| Change | What it does |
| --- | --- |
| `classification_rules.amount_includes_vat`, `.separates_included_vat` | The line's amount has VAT inside it; the line takes stated VAT back out. Never both |
| 61 noon rules | Import and classification rules for the Transaction View and the Invoices and Credit Notes, generated from `src/services/marketplaces/noon/rules.ts` |
| `marketplaces.NOON` | `AVAILABLE` |
| `source_rows_row_hash_idx`, `ledger_apply_file()`, `ledger_file_restore()` | A file (or a restored file) whose rows are already counted for the account in another file is refused, naming that file. Otherwise unchanged from 0031 / 0030 |
| `ledger_classified_lines` | Adds `rule_includes_vat`, `rule_separates_vat` |
| `pnl_summary(from, to, account, business, combine_by_currency)` | Recreated: business filter, one row per currency when combined (`accounts` counts them; `input_vat_treatment` is `MIXED` when they differ), new reason `FEE_VAT_NOT_SEPARATED` |
| `ledger_data_quality(...)` | Recreated with `FEE_VAT_NOT_SEPARATED`, one item per month |

No rollback script: to undo, retire the noon rules and set NOON back to
`SAMPLES_REQUIRED`; the added columns and checks are harmless unused.

---

## 8. Regenerating types

`src/types/database.ts` is currently hand-written to match the migrations. Keep
it in sync in the same commit as any schema change, or regenerate it:

```bash
npx supabase gen types typescript --project-id <your-project-ref> > src/types/database.ts
```

A mismatch between this file and the real schema produces code that compiles
and then fails at runtime, which is the worst kind of bug. Treat the types as
part of the migration, not as an afterthought.
