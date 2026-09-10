# Roadmap — Phases 9 to 12

**This file was written when all four phases were designs.** Three have since
been built, and the `PHASE*` documents below are kept as the record of what was
*intended* — where a built phase departed from its design, the built document
is the authority.

| Phase | Designed as | State |
| --- | --- | --- |
| 10 — Sync + webhook engine | [PHASE10_SYNC.md](PHASE10_SYNC.md) | ✅ **Built** — [INTEGRATION_ENGINE.md](INTEGRATION_ENGINE.md) |
| 9 — WooCommerce | [PHASE9_INTEGRATIONS.md](PHASE9_INTEGRATIONS.md) | ✅ **Built** — [WOOCOMMERCE.md](WOOCOMMERCE.md). Never run against a real store |
| 9 — Shopify | [PHASE9_INTEGRATIONS.md](PHASE9_INTEGRATIONS.md) | Designed. **Deferred by the owner.** Blocked on 6 decisions |
| 11 — Alerts + automation | [PHASE11_AUTOMATION.md](PHASE11_AUTOMATION.md) | ✅ **Built** — [AUTOMATION.md](AUTOMATION.md) |
| 12 — AI recommendations | [PHASE12_AI_RECOMMENDATIONS.md](PHASE12_AI_RECOMMENDATIONS.md) | Designed. Blocked on 3 |

The engine was built before the first connector, against a fixture connector,
exactly as §1 recommended — and nothing in the engine changed to accommodate
WooCommerce afterwards, which was the point.

---

## 1. What the existing codebase already gives these phases

This is the useful half of the answer. Phases 5 to 8 built more of the
integration layer than the phase numbering suggests.

| Already built | Serves |
| --- | --- |
| `RawRecord[] → Mapping → validate → normalise → apply` | Every connector. The contract comment in `contracts.ts` names Shopify explicitly |
| Partial unique `(business_id, source, external_id)` | Idempotent re-sync, proven by tests |
| `import_batches` / `import_issues` | Becomes `sync_jobs` / partial-failure recording |
| `source_records` — raw payloads kept verbatim | Vendor lineage. See §2.1 |
| `source_field_semantics` + the gate | Stops a vendor field becoming a metric unchecked |
| `canonical_metrics` | Automation rules and recommendations target real metrics |
| Money as exact text (MONEY.md) | Vendor decimals survive into analytics unchanged |
| `write_audit_log()` | Automation and connection changes |
| The AI guard and degradation path | Phase 12 extends it rather than rebuilding |
| Six live test suites in a settled style | The pattern every new suite follows |

**The universal data model needs no new business tables for Phase 9.** Orders,
items, products, variants, customers, inventory, payments, returns and channels
already carry `source`, `external_id` and `business_id`.

---

## 2. Architectural changes that should happen BEFORE implementation

Four, found by inspecting the code rather than assuming.

### 2.1 There is no `source_metadata` column — and there should not be

The brief asks that source metadata and lineage be preserved. `source` and
`external_id` exist on every syncable table; a per-row `jsonb` blob does not.

**Recommendation: do not add one.** `source_records` (migration 0008) already
preserves a source record verbatim, with `blank_fields` and reconciliation
`checks`, and `webhook_events.raw_body` (Phase 10) will keep the payload as
received. Adding a third copy on every business row would triple storage and
create three places for the truth to disagree.

Lineage is then: business row → `source` + `external_id` → `source_records` /
`webhook_events` → `source_field_semantics` for what each field means.

**Gate: confirm this satisfies the lineage requirement before Phase 9 starts.**

### 2.2 `proxy.ts` runs `getUser()` on every request, including webhooks

`src/proxy.ts` calls `supabase.auth.getUser()` — a network round trip to the
auth server — for every path the matcher accepts, which today is everything
except static assets.

A webhook has no session, so that round trip buys nothing. It also spends part
of a budget that is not ours: **Shopify allows five seconds total and deletes
the subscription after eight consecutive failures.**

**Change required: exclude `/api/v1/webhooks` from the proxy matcher.** One
line, but it must land before the first webhook route exists, not after a
merchant is silently unsubscribed.

### 2.3 The session-less write path is undecided

Webhook handlers and sync workers have no user session, so RLS cannot resolve
the tenant from `current_user_business_ids()`.

CLAUDE.md forbids the service-role key for a *user request*; a verified vendor
webhook is a background job, which that rule allows. But the blast radius must
be one narrow function that resolves the tenant from the connection itself —
not a general-purpose service-role client that any future code could reach for.

**This is the single most important decision in Phase 9/10 and it is shared by
both.** Decide it once, write it down, and test it by attack.

### 2.4 `channels` needs a link to a connection

`channels` exists and orders reference it. A connection creates or reuses a
channel row, and the relationship needs stating: one connection per channel per
business, or many. Small, but it decides whether reconnecting a store produces
a duplicate channel and quietly splits the history.

---

## 3. Unresolved decisions, consolidated

**Blocking Phase 9**

1. **Public app or custom app.** A public app needs Shopify review plus two
   approvals (`read_all_orders`, protected customer data). A custom app needs
   neither but cannot be listed. This decides weeks of lead time.
2. **Connector semantics confirmation** — one owner confirmation at connect
   time (recommended) versus a system actor id that weakens the Phase 7.2 gate.
3. **Token encryption at rest** — column-level with an external key, or rely on
   Supabase disk encryption.
4. **Which Shopify total is BizMind revenue** — `totalPrice`,
   `currentTotalPrice`, or `subtotalPrice`. Must be decided once and tested.
5. **Bulk Operations for initial sync** — likely correct, unverified.
6. **Session-less write path** (§2.3).

**Blocking Phase 10**

7. `sync_jobs` versus extending `import_batches`.
8. `webhook_events` retention — decide before the table is large.
9. Cron cadence, and whether a nightly reconciliation sweep is V1.
10. Whether a missed-webhook detector is V1.

**Phase 11 — settled during the build (see AUTOMATION.md)**

11. ~~Inventory-days and receivables metrics do not exist.~~ **Confirmed and
    accepted.** Both rules are not built rather than approximated. Days-of-cover
    needs a per-SKU sales rate the model does not carry; receivables needs
    invoices, which it does not have at all. A third gap surfaced: `refund_rate`
    is computed by analytics but is not in the canonical vocabulary, so no rule
    can target it — the refunds template watches the month-on-month change
    instead. Adding it to the vocabulary is a small follow-up.
12. Notification channel — **still open.** V1 is in-app only: alerts are rows an
    owner sees when they look. Email or push is the obvious next step and needs
    a provider decision.
13. ~~Evaluation cadence and cooldown semantics.~~ **Settled.** Cadence is
    per-rule (`evaluate_every_minutes`, default 60) with the worker claiming
    what is due; cooldown is per-rule hours since the last **FIRED** run,
    default 24. Zero is permitted and is not the default.

**Blocking Phase 12**

14. Brief cadence and timezone handling.
15. Cost caps and token accounting.
16. Whether to generate a brief when nothing changed.

---

## 4. Manual steps required from the owner

Nothing below can be done from the terminal.

**Before Phase 9 — Shopify**
1. Create a Shopify Partner account.
2. Decide public app or custom app (decision 1 above).
3. Create the app; record client id and secret.
4. Set the redirect URI to the deployed callback.
5. If public: request `read_all_orders` approval and protected customer data
   access. **Both are gated on Shopify's timeline, not ours.**
6. Create a development store for testing.

**Before Phase 9 — WooCommerce**
7. On a real store: WooCommerce → Settings → Advanced → REST API → Add key,
   permission **Read**.
8. Copy the consumer key and secret once — they are not shown again.
9. Confirm the store is served over HTTPS.

**Before Phase 10**
10. Add the cron schedule to `vercel.json`. **Still outstanding, and it now
    covers two workers: the sync worker and `/api/v1/automation/run`.** Until
    it exists, rules are only evaluated when somebody presses "run now".
11. Set webhook signing secrets in environment variables.

**Before Phase 11 runs on a schedule**
12. Set `CRON_SECRET` in the hosting environment. The automation route refuses
    every request while it is unset — deliberately, so a missing variable
    cannot quietly become a public endpoint.

**Before Phase 11 (only if email is chosen)**
13. Choose a provider and verify a sending domain. V1 is in-app only.

**Before Phase 12**
14. Nothing. The OpenAI key is configured and verified.

**Carried over from earlier phases, still outstanding**
15. **Re-enable "Confirm email" in Supabase before real customers.** It is off.
16. Delete the two throwaway QA users (`qa-primary-…`, `qa-secondary-…`).

---

## 5. Recommended implementation order

The ordering principle: **build the thing that can be verified against reality
first, and never build a second connector before the first has proven the
shared engine.**

**0. Decide 1–6 above.** Nothing should start before the app type and the
session-less write path are settled; both are expensive to change later.

**1. Pre-implementation changes (§2).** Small, isolated, no vendor involved.

**2. Phase 10 skeleton, before Phase 9.** `sync_jobs`, `sync_runs`,
`webhook_events`, the claimer, retry and backoff — tested with a **fake
in-repo connector** that returns fixture records. This is deliberate: it lets
the engine be proven with no credentials, no vendor and no network, and it
means the first real connector plugs into something already working.

*This is the opposite of the phase numbering, and it is the right order.*

**3. Phase 9 — WooCommerce first.** Simpler auth (a key and a secret, no OAuth
dance, no app review, no approvals), and it can be tested against a local
install. It will find the mapping bugs cheaply.

**4. Phase 9 — Shopify.** GraphQL, OAuth with token refresh, cost-aware
throttling. The hardest connector, attempted once the pipeline is known good.

**5. Reconciliation sweep.** Before trusting webhooks, prove the numbers match
the vendor's own totals. A silent gap is the failure mode that matters.

**6. Phase 11 — automation.** Needs live data flowing to be meaningful. Start
with the three rules whose metrics exist; defer inventory-days and receivables.

**7. Phase 12 — brief and recommendations.** Last, because it is the layer that
*explains* everything beneath it, and it is the only one that degrades to
nothing without harm.

---

## 6. What must not happen

- No connector built on Shopify's REST Admin API. It is legacy, and a new app
  cannot use it.
- No fake credentials, fake stores, or fabricated production data. Contract
  tests run on recorded fixtures with customer data scrubbed.
- No financial arithmetic in TypeScript, React or a prompt. Enforced by
  `npm run test:money-guard`.
- No LLM executing a business action. V1 automation is deterministic and
  auditable; recommendations always carry `requires_approval: true` and there
  is no executor to approve them into.
- No `business_id` from a client request. Session, or verified connection.
- No table without RLS.
