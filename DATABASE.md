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

Migration `0001_identity_and_tenancy.sql` — identity and tenancy only. The
business data model (orders, products, expenses…) arrives in Phase 5.

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

## 3. Indexes

| Index | Why |
| --- | --- |
| `business_members(user_id)` | The hot path. Every RLS check resolves the caller's businesses through this column |
| `business_members(business_id)` | Member lists, role checks |
| `businesses(created_by)` | Ownership lookups |
| `businesses(slug)` | Created automatically by the UNIQUE constraint |

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
