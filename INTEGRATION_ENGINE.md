# The integration engine

**Built and tested. No real provider is connected to it yet.**

> **Correction — migration 0018.** The write path in section 8 never wrote a
> row until 0018. `sync_apply_orders()`, `sync_apply_products()` and
> `webhook_apply_records()` created batches with `file_type = 'api'`, which the
> database's own rule refused, so every write rolled back — and synced orders
> would have carried no channel even had they landed. No test passed them a
> row, which is how it hid. Section 6b of the live suite now does.

Shopify and WooCommerce plug in here. This document describes what they plug
into, and — more usefully — the rules they will not be able to break.

---

## 1. The dividing line

```
Connector          how to ask one provider for a page, and what its
                   signature header means

Engine             when to ask, what to do when it fails, how to be sure the
                   same order is not written twice, and whose data it is
```

A connector that retries, schedules, or decides a tenant has taken a job that
belongs to the engine — and taken it once per provider. That is how the sixth
integration ends up costing as much as the first.

A connector may **not**: write to a business table, calculate a financial
figure, decide which business a record belongs to, or retry.

---

## 2. The session-less path

Every other table in this database is protected by RLS keyed on `auth.uid()`.
A webhook has no session. `write_audit_log()` even raises
`28000 Not authenticated` without one — so the path had to be built explicitly.

```
provider + external account id  →  integration_accounts  →  business_id
```

**The business is derived from a connection row an authenticated owner
created.** It is never read from a request body, a header, or a query
parameter. An unrecognised store resolves to nothing and the delivery is
dropped: it is not guessed at, and it does not become somebody else's.

### The order of operations is the security model

```
1. read the RAW body            bytes, untouched
2. identify the provider        from the path, against a registry
3. identify the store           from headers — still untrusted
4. resolve the connection       the ONLY source of the tenant
5. verify the signature         constant time, over the raw body
6. persist                      a unique key decides duplicates
7. return quickly               processing happens later
```

Nothing before step 4 is trusted. Nothing after step 5 happens if verification
failed.

### Why it returns before processing

Shopify allows **five seconds in total** and **deletes the subscription after
eight consecutive failures**. Normalising and writing inline would eventually
exceed that on a busy store, and the punishment is silent — no error, just a
store that quietly stops updating.

---

## 3. Privilege, and how little of it there is

Two modules hold the service-role key, both under
`src/services/integrations/security/`:

| Module | Does |
| --- | --- |
| `privileged.ts` | Calls an **allowlist** of tenant-resolving functions |
| `store-secrets.ts` | Writes two credential columns on one table |

`privileged.ts` never exports the client. It exports `callTrusted()`, which:

- refuses any function not on the allowlist, **at runtime as well as in the
  type** — a type is erased, and this is the one place being wrong is expensive
- **refuses any call carrying a business id**, because every function it can
  reach derives its own tenant and there must be no parameter to point at
  another one

CLAUDE.md forbids the service-role key for serving a *user request*. That rule
is not bent: a verified vendor callback and a scheduled worker are background
jobs, which is the case it explicitly allows.

A test asserts the key appears in exactly those two files.

---

## 4. Credentials

AES-256-GCM from Node's own `crypto`. The key lives in
`BIZMIND_ENCRYPTION_KEY`, in the environment — **never in the database**, so a
database backup on its own does not yield a usable credential.

Every ciphertext is bound to a context: `business_id` + purpose. The attack
this defends against is not "read the secret" but **"move a valid secret to a
row where it authorises something else"**. A ciphertext carried across tenants
fails authentication rather than decrypting.

Format `v1.<iv>.<tag>.<ciphertext>` — versioned so the scheme can be rotated
without guessing what an old value was.

### The columns are unreadable by users

`authenticated` is granted SELECT, INSERT and UPDATE on
`integration_accounts` **column by column, with the two credential columns
left out**. RLS decides which *rows* are visible; a column grant decides which
*columns*. Without this an owner could read their own encrypted tokens through
PostgREST — and "encrypted" is not "safe to hand to a browser".

**It is a grant list rather than a revoke list, and that distinction is the
whole thing.** The first version granted SELECT on the whole table and then
revoked two columns. That does nothing: in PostgreSQL a column-level REVOKE
cannot remove a table-level GRANT. The migration's own verification block
caught it and refused to install — which is why that block asserts privileges
rather than trusting that the statements above did what they read as doing.

Adding a column to this table means adding it to those lists. Forgetting means
the column is invisible rather than exposed: the safe direction to fail in.

Two consequences follow, and both are tested:

- `SELECT *` is **refused outright**, because it needs SELECT on every column.
- `integration_account_connect()` is SECURITY DEFINER (it does `RETURNING *`)
  and **blanks the secret fields before returning**, so a reconnect does not
  hand back the ciphertext that already exists.
- The audit "before" snapshot has those keys stripped, or `to_jsonb(row)`
  would copy the ciphertext into a table admins can read.

### A credential can belong to the business (0022)

Google is signed into once per business, not once per sheet, so its sealed
refresh token lives on the `integrations` row. `integrations` is protected the
same way as `integration_accounts`: everything revoked, then granted back
column by column without `credentials_encrypted`. `sync_job_context()` hands
the worker the connection's own credential when it has one, and the
business's otherwise. The worker decrypts both the same way, because both are
sealed with the same business and purpose.

---

## 5. Connection identity

`external_account_id` is the provider's own permanent name for a store: a
`myshopify.com` domain, a WooCommerce site URL.

Connecting is an **upsert** on `(business_id, integration_id, external_account_id)`,
and the channel is carried across.

**Why this matters more than it looks.** A second channel for the same store
would split its history in two, and every figure that groups by channel would
quietly halve. Nobody would see an error.

A partial unique index on `(provider, external_account_id)`
`where status <> 'DISCONNECTED'` means **one live store belongs to exactly one
business**. It is partial so a store can be disconnected and later connected by
someone else.

`provider` is denormalised onto `integration_accounts` for this, and held
there by a composite foreign key onto `integrations(id, provider)` — so the
copy cannot drift from its parent.

**The first version keyed this on `integration_id` and did nothing.**
`integrations` is unique on `(business_id, provider)`, so two businesses have
two different `integration_id` values and the same store connected by both did
not collide. The live suite caught it.

That was not a cosmetic duplicate. `webhook_account_lookup()` ends in
`LIMIT 1`; with two matching rows, a delivery would have landed in whichever
tenant the planner returned first — a silent, unreproducible cross-tenant
write. Migration 0014 fixed it and its verification block refuses to install if
the index is ever keyed on `integration_id` again.

---

## 6. Idempotency, decided by the database

**Webhooks.** `unique (business_id, idempotency_key)` on `webhook_events`.

Not an application-level "if exists" check: two concurrent redeliveries both
pass an existence check and both insert. Only the database can decide this
once. Five redeliveries produce one row, one processing result, and zero
duplicate business mutations — asserted live.

**Sync.** The existing partial unique index
`(business_id, source, external_id)` from migration 0002. A provider repeating
a record across pages is ordinary, not exotic: anything ordered by an
`updated_at` that ticks during a sync will do it.

Two independent defences, both already proven by earlier phases.

---

## 7. The sync lifecycle

```
QUEUED → RUNNING → SUCCEEDED
                 → PARTIAL        some rows applied, cursor still advanced
                 → RETRYING       backoff, then claimed again
                 → DEAD_LETTER    out of attempts. Needs a person
```

**One page per claim.** A serverless function has a wall-clock limit, and a
worker that must finish a whole store or lose its progress never finishes a
large store. Because the cursor is durable, being cut off costs one page.

**The cursor is written last.** Advancing it before the records are applied
would skip data on a crash — silently, with nothing to notice.

**Retry:** exponential from 30s, capped at 8h, with **full jitter** — a random
point in `[0, exponential]`. Without it a thousand connections failing on one
provider outage retry in lockstep and become the outage.

**A rate limit is not a failure.** The attempt is refunded. Charging one would
kill a healthy sync of a busy store.

**A permanent error skips the queue.** A revoked token cannot be fixed by
waiting, so it goes straight to `DEAD_LETTER` rather than burning seven
attempts discovering that.

**Partial failure applies the good rows.** Losing 247 orders because 3 were
malformed protects nothing; the 3 are recorded in `import_issues`.

**Claiming uses `FOR UPDATE SKIP LOCKED`** — the second worker walks past a
held row rather than blocking on it or duplicating it.

---

## 8. Nothing bypasses the ingestion pipeline

```
SOURCE → RAW → MAPPING → VALIDATION → NORMALIZATION → CANONICAL → ANALYTICS
```

A connector produces `RawRecord`s. `sync_apply_orders()` and
`webhook_apply_records()` create an import batch and call the **existing**
`import_apply_orders()` — the same function the CSV importer uses, with the
same validation, the same idempotency, and the same refusal to turn a blank
into a zero.

Both take a **job id** or an **event id**, never a business id: the tenant is
derived, so a worker cannot be pointed at another one.

The batch records `file_type = 'api'` and the **connection's channel**, which
`integration_account_connect()` creates and links. Without the channel,
`import_apply_orders()` — which takes it from the batch — would attribute every
synced order to no channel at all. Both were broken until migration 0018.

A test asserts no file under `src/services/integrations/` converts a money
value to a number or imports the analytics service.

---

## 9. The fixture connector

**Not a fake integration, and it produces no production data.** It exists to
prove the engine.

Every failure a real provider will eventually inflict is available on demand,
deterministically, with no network and no credentials: a rate limit, a 500 that
clears, a revoked token, a page that repeats a record, a page with one
unusable row, a forged signature, a delivery with no identity.

Behaviour is chosen by a `scenario` in the connection metadata, so a test asks
for the failure it wants rather than waiting for one.

The scenarios that clear on the second attempt are the important ones: they let
a test assert the engine **recovered**, not merely that it gave up politely.

It uses `channelType: "OTHER"` rather than a new enum value — a test-only
concept has no business widening a production enum that analytics groups by.

---

## 9a. What migration 0020 changed

Building Google Sheets on this engine surfaced a fourth defect and several
gaps. See [GOOGLE_SHEETS.md](GOOGLE_SHEETS.md) for the connector they serve.

- **Pages continue.** `sync_job_complete()` used to mark a job `SUCCEEDED` even
  when the connector said more pages remained, and the worker only claims
  `QUEUED` or `RETRYING` jobs — so every resource stopped after page one. The
  worker now passes `p_has_more`, and a page with more to come re-queues its
  job at once.
- **A running job is never stolen.** Queuing a job a worker held used to clear
  its lease, so two workers could write at once. Now the request sets
  `rerun_requested`, honoured the moment the running sync finishes. A full
  re-import on top of a running pass is refused.
- **`source` comes from the connection's channel**, falling back to the
  provider. For WooCommerce and the fixture that is exactly the value it always
  was, so no existing record moves.
- **Paused, needs-reauthorisation and needs-mapping-review connections are
  never claimed.** Only the owner pauses or disconnects; the worker records
  what it found through `integration_account_set_state()` and may do nothing
  else.
- `EXPENSES` is a sync resource; every run records why it ran and how many rows
  it inserted, updated, left unchanged or rejected; every batch records the
  connection and run it came from.

## 9b. What migration 0023 changed

- **A DEAD_LETTER from the worker is final.** `sync_job_complete()` used to
  retry a permanent failure until its attempts ran out, whatever the worker
  said — despite the worker's own comment promising "straight to the state a
  person can see". Now it goes straight there.
- **Waiting for a person is not a failure.** When a connector reports
  `REAUTH_REQUIRED` or `MAPPING_REVIEW_REQUIRED`, the worker sets the
  connection to that state and parks the job (`RETRYING`, attempt refunded)
  instead of dead-lettering it. The connection's state keeps it from being
  claimed; the owner's fix turns the connection back to `CONNECTED` and the job
  continues. A dead letter would need a second rescue that nothing performs.
- **Expenses are written by `sync_apply_expenses()`.** The worker chose its
  apply function with a two-way test, so an expenses page would have gone to
  `sync_apply_orders()`. It now chooses among all three.
- **Table-shaped pages** (a spreadsheet) are prepared by `sync/tabular.ts` and
  applied by `applyTabularPage()`. See GOOGLE_SHEETS.md, section 6b.
- **`drainSyncQueue()`** keeps claiming until the queue is empty or a time
  budget is spent. Used by the scheduled route and straight after an owner
  connects a sheet or asks for a sync.
- The trusted allowlist gains `sync_apply_expenses`, the three record-state
  functions, `sync_record_issues`, `integration_account_set_state` and
  `sync_reconcile_due`. Each derives its tenant from a job or account row;
  `sync_reconcile_due` takes no id and returns only a count.

## 10. Tests

```bash
npm run test:integration-engine   # 77 assertions, no database, no network
npm run test:integration-live     # 187 assertions, against the real database
npm run verify:integrations       # both
```

The offline suite covers crypto (including cross-tenant ciphertext rejection),
signature comparison, the registry, pagination and cursor progression, every
failure kind, duplicates and partial pages, webhook identification and
verification, the narrowness of the privileged door, secret non-leakage, the
raw-body rule, the proxy exclusion, and the absence of money arithmetic.

The live suite covers connect and reconnect, credential unreadability, enqueue
idempotency, tenant isolation, anonymous denial, webhook ingest and duplicate
handling, unknown-store rejection, worker claiming under concurrency, replay
authorisation, and disconnection.

### Adversarial cases, all expected to be DENIED

- B reads A's connections, jobs, runs, events, logs
- **B disconnects A's connection using its id** (IDOR)
- **B triggers a sync on A's connection**
- **B replays A's webhook event using its id**
- B inserts an integration into A's business
- **A connects a store already live on another business**
- A signed-in user calls any session-less function
- Anonymous reads any integration table
- An unverified delivery is replayed

### Sections that need the service-role key are SKIPPED LOUDLY

Never silently passed. A security test that quietly did not run is worse than
one that failed.
