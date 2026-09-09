# Phase 10 — Sync and webhook reliability engine

**Status: DESIGN ONLY. Nothing here is implemented.**

One engine, every source. Shopify and WooCommerce are the first two; Amazon,
Daraz, Noon, eBay, a custom REST API and a future ERP must fit without the
engine being rewritten.

---

## 1. Architecture

```
Integration          what a vendor is, and how to talk to it   (Phase 9)
     ↓
Connection           one merchant's store, with its credentials
     ↓
Initial sync         everything, once, in pages, checkpointed
     ↓
Incremental sync     what changed since the checkpoint
     ↓
Webhook              the vendor tells us something changed
     ↓
Verification         signature checked before anything else
     ↓
Idempotency          the same event twice does nothing twice
     ↓
Queue                durable work, retried, never lost
     ↓
Normalisation        the existing ingestion pipeline
     ↓
Universal data model the existing tables
     ↓
Analytics            unchanged
```

**The engine knows nothing about any vendor.** It schedules work, enforces
idempotency, retries, and records what happened. Vendor knowledge lives behind
the connector interface from Phase 9. That is what stops the sixth integration
being as expensive as the first.

### The webhook path, split deliberately in two

```
receive → verify signature → INSERT webhook_events → 200 OK      (< 100ms)
                                      ↓
                              worker picks it up
                                      ↓
                        normalise → apply → mark processed
```

Shopify allows **five seconds total** before it treats a delivery as failed,
and deletes the subscription after eight consecutive failures. Doing real work
inside the handler is therefore not a performance preference — it is the
difference between staying subscribed and being silently unsubscribed.

---

## 2. Database

### sync_jobs — what should happen, and when

```
id, business_id, connection_id
kind            INITIAL | INCREMENTAL | BACKFILL | WEBHOOK_REPLAY
entity          ORDERS | PRODUCTS | CUSTOMERS | INVENTORY | REFUNDS
status          PENDING | RUNNING | SUCCEEDED | FAILED | DEAD
priority        smallint
scheduled_for   timestamptz
attempts        integer
max_attempts    integer
last_error      text
cursor          text          -- the checkpoint; see §3
created_at, updated_at
```

`import_batches` from Phase 5 was deliberately shaped to become this: it
already records a source, a status, counts and an error. The two may merge, or
`sync_jobs` may reference a batch per run. **Open decision (§10).**

### sync_runs — what actually happened, once per attempt

```
id, business_id, job_id, attempt
started_at, finished_at
status, records_read, records_written, records_failed
cursor_before, cursor_after
rate_limit_waits integer
error
```

A job is intent. A run is history. Keeping them apart is what makes "this store
has failed four nights running, always at the same cursor" a question the
database can answer.

### sync_logs — the detail, bounded

```
id, business_id, run_id, level, message, context jsonb, created_at
```

Retained 30 days. Never contains a credential — enforced by a test that scans
for token-shaped strings.

### webhook_events — the raw truth, kept

```
id, business_id, connection_id
source           channel_type
topic            text
external_event_id text        -- X-Shopify-Webhook-Id / X-WC-Webhook-Delivery-ID
external_id      text         -- the order/product the event is about
raw_headers      jsonb
raw_body         text         -- exactly as received; needed for verification
signature_valid  boolean
received_at, processed_at
status           RECEIVED | PROCESSED | FAILED | DUPLICATE | DEAD
attempts, last_error

unique (business_id, source, external_event_id)
```

The raw body is stored verbatim, like `source_records` in Phase 7.1 and for the
same reason: it is the evidence. When a figure looks wrong six months later,
the question "what did Shopify actually send us?" must have an answer.

### The idempotency key

The unique index on `(business_id, source, external_event_id)` is the whole
duplicate-prevention mechanism. A repeated delivery hits it, is marked
`DUPLICATE`, and returns 200 — vendors retry, and a retry must be free.

Beneath that, the **existing** partial unique index
`(business_id, source, external_id)` on business tables (migration 0002) means
that even a duplicate that slips through updates a row rather than creating a
second one. Two independent defences, both already proven.

---

## 3. Checkpoints

| Vendor | Cursor |
| --- | --- |
| Shopify | `pageInfo.endCursor` — opaque, stored as text |
| WooCommerce | Highest `id` seen, plus a `modified_after` timestamp |
| Future REST | Whatever the vendor gives; the column is text |

A checkpoint is written **only after the page it covers is durably applied.**
Writing it first would silently skip data on a crash — the failure mode where
nobody notices anything is missing.

`connection.last_successful_sync_at` is separate from the cursor: one answers
"how fresh is this?", the other "where do I resume?".

---

## 4. Retry, backoff, failure

```
attempt 1   immediately
attempt 2   +30s
attempt 3   +2m
attempt 4   +8m
attempt 5   +30m
attempt 6   +2h
attempt 7   +8h
then        DEAD
```

Exponential with **full jitter** — without it, a thousand connections failing
on the same outage retry in lockstep and become the outage.

**Rate limits are not failures.** A `429` or a Shopify `THROTTLED` waits the
advised time and retries *without consuming an attempt*. Counting them would
kill a healthy sync of a busy store.

**Dead letter:** status `DEAD`, the run history intact, and the owner told —
plainly, not in a log nobody reads. "Your Shopify sync has been failing since
Tuesday" is business-critical information, not a technical detail.

**Partial failure:** a page of 250 orders where 3 fail writes the 247 and
records 3 in `import_issues` (the Phase 5 table, already built). The cursor
advances. Losing 247 good orders because 3 were malformed is worse than the
alternative, and the 3 are on record.

**Replay:** a `WEBHOOK_REPLAY` job re-processes stored `webhook_events` in a
window. Because the raw body was kept, replay needs nothing from the vendor.

---

## 5. Queue

**No queue provider yet.** The requirement is durability and ordering, and
PostgreSQL provides both:

```sql
select * from sync_jobs
where status = 'PENDING' and scheduled_for <= now()
order by priority, scheduled_for
for update skip locked
limit 10;
```

`FOR UPDATE SKIP LOCKED` is the standard pattern for a work queue in Postgres
and scales to far more than this product will need for a long time. It costs
one table.

**Scheduling:** Vercel Cron invokes a worker route on a schedule; the worker
claims and processes a batch within the function's time limit, then returns.
Long jobs are resumed by the next tick because the cursor is durable.

**The constraint to respect:** a serverless function has a wall-clock limit.
Work must be **resumable at any point**, which the cursor design already
delivers. A worker that must finish or lose everything is the design to avoid.

**When to revisit:** if a single merchant's initial sync cannot complete in a
reasonable number of ticks, or if fan-out across merchants needs real
concurrency control, move to a dedicated queue. The job table stays; only the
claimer changes. That is the point of putting it here.

---

## 6. Security, RLS, tenant isolation

Every table above carries `business_id` with RLS enabled and forced, and the
same four policies as the rest of the schema.

**The webhook path has no user session.** The tenant is derived from the
verified connection: shop domain or webhook id → `integration_connections` →
`business_id`. An unrecognised shop is dropped, not guessed at.

The worker also has no session. Its write path must be narrow — a function that
takes a job id, resolves the tenant itself, and cannot be pointed at another
one. **This is the same open decision as Phase 9 §8** and should be settled
once, for both.

`raw_headers` must have the signature header **redacted before storage**: it is
a MAC over a body we already keep, and storing both together is unnecessary.

---

## 7. Observability

Structured logs, never credentials:

```
sync.started      connection, entity, cursor
sync.page         records, cost, throttle remaining
sync.throttled    waited_ms
sync.finished     written, failed, duration
webhook.received  topic, event id, valid
webhook.duplicate event id
job.retry         attempt, next_at, error class
job.dead          attempts, first_error, last_error
```

What the owner sees is different and shorter: **is my store connected, when did
it last sync, and is anything wrong?** A red banner saying sync has been failing
for three days beats a perfect log nobody opens.

Health signals worth a dashboard tile: oldest unprocessed webhook, connections
with `last_successful_sync_at` older than a day, jobs in `DEAD`.

---

## 8. Testing

- Idempotency: same event twice → one row, second marked `DUPLICATE`.
- Crash mid-page → cursor unchanged → replay writes the missing rows once.
- Backoff schedule and jitter bounds.
- Throttle response does not consume an attempt.
- Partial failure writes the good rows and records the bad ones.
- Dead-letter reached after the configured attempts, and surfaced.
- Tenant isolation: a webhook for A's shop cannot write into B; a worker
  claiming A's job cannot read B's connection.
- Replay from stored raw bodies reproduces the same result.

All against the live database, in throwaway tenants, in the style already
established by the six live suites.

---

## 9. Cost and scalability

Postgres-backed queueing costs one table and some index maintenance. Webhook
receipt is cheap; processing is the cost, and it is proportional to real
business activity.

The first scaling limit is worker throughput per cron tick, and the fix is more
frequent ticks or a real queue — neither of which touches the connectors.

The second is table growth: `webhook_events.raw_body` is the largest thing
here. Retention (say 90 days hot, then archived or summarised) should be
decided before launch, not after the table is 40GB. **Open decision (§10).**

---

## 10. Open decisions

1. `sync_jobs` versus reusing `import_batches` — merge, or reference.
2. `webhook_events` retention and archival.
3. The narrow write path for session-less workers (shared with Phase 9 §8).
4. Cron cadence, and whether incremental sync is needed at all once webhooks
   are reliable — a nightly reconciliation sweep is probably still wise, since
   webhooks can be missed and a silent gap is the worst kind.
5. Whether a missed-webhook detector (compare vendor counts against ours) is
   V1 or later.

---

## 11. Manual steps for the owner

- Configure the Vercel Cron schedule (one line in `vercel.json`).
- Set the webhook signing secrets in environment variables.
- Nothing else. Webhook registration is automatic at connect time.

---

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Webhook handler exceeds 5s | Verify, persist, 200. Work happens later |
| Subscription silently deleted | Detect and re-register; alert the owner |
| WooCommerce webhook auto-disabled after 5 failures | Detect and re-enable |
| Cursor advanced before durable write | Write the cursor last, always |
| Retry storm during an outage | Full jitter |
| Silent data gap | Nightly reconciliation sweep |
| Credentials in logs | Redaction, plus a scanner test |

---

## 13. Rollback

Additive tables and additive routes. Disabling the cron stops the engine and
leaves existing data untouched; the file importer and dashboard are unaffected
because nothing in the existing pipeline changes.
