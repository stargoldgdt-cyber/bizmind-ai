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

PostgREST returns numerics as **JSON strings** to preserve that precision, and
`src/types/database.ts` types them as `string` deliberately. Parsing one into a
JavaScript number reintroduces the very problem `numeric` avoids. **All
financial arithmetic happens in SQL** — the same rule that keeps the AI away
from calculations.

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

## 8. Regenerating types

`src/types/database.ts` is currently hand-written to match the migrations. Keep
it in sync in the same commit as any schema change, or regenerate it:

```bash
npx supabase gen types typescript --project-id <your-project-ref> > src/types/database.ts
```

A mismatch between this file and the real schema produces code that compiles
and then fails at runtime, which is the worst kind of bug. Treat the types as
part of the migration, not as an afterthought.
