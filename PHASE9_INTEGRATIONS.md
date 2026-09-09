# Phase 9 — Shopify and WooCommerce

**Status: DESIGN ONLY. Nothing here is implemented.**

This document is the plan and the evidence behind it. Every API fact was taken
from official vendor documentation on 2026-09-09; the references are in §10.

---

## 0. The finding that shapes this phase

**Shopify's REST Admin API is legacy, and a new app cannot use it.**

- REST Admin API has been **legacy since 1 October 2024**.
- **From 1 April 2025, all new public apps must be built exclusively on the
  GraphQL Admin API.**

BizMind has no Shopify app yet, so it is a new app. Phase 9 is **GraphQL-only**
for Shopify. Any tutorial showing `/admin/api/2024-01/orders.json` is
describing a door that is closed to us.

This is not a preference. Building on REST would produce an integration that
cannot be listed, and the work would be thrown away.

---

## 1. Architecture

Both connectors sit behind the interface the file importer already uses. From
`src/services/ingestion/contracts.ts`:

```
Source ──► RawRecord[] ──► Mapping ──► validate ──► normalise ──► apply
                              ▲
               file: chosen by the user
            Shopify: fixed by the connector
```

That comment was written in Phase 5 and is the contract this phase honours. A
connector's job is to produce `RawRecord[]` and a `Mapping`. Everything
downstream — validation, normalisation, the atomic write, the semantics gate —
is already built and shared.

```
src/services/integrations/
├── contract.ts              What every connector must implement
├── registry.ts              Connector lookup by channel_type
├── shopify/
│   ├── auth.ts              OAuth, HMAC, token refresh
│   ├── client.ts            GraphQL transport, cost-aware throttling
│   ├── queries.ts           The GraphQL documents, one per entity
│   ├── mapper.ts            Shopify node -> RawRecord
│   └── webhooks.ts          Topic registration and verification
└── woocommerce/
    ├── auth.ts              Basic auth over HTTPS only
    ├── client.ts            REST transport, pagination
    ├── mapper.ts
    └── webhooks.ts
```

**The connector interface** (proposed):

```ts
type Connector = {
  channel: ChannelType
  /** Vendor-documented field meanings, seeded at connect time. */
  fieldSemantics: SourceFieldDefinition[]
  connect(input): Promise<Connection>
  fetchPage(entity, cursor): Promise<{ records: RawRecord[]; nextCursor: string | null }>
  verifyWebhook(headers, rawBody): boolean
  parseWebhook(headers, rawBody): { topic: string; externalId: string; eventId: string }
  disconnect(connection): Promise<void>
}
```

No connector writes to a business table. It returns records; the existing
pipeline writes them.

---

## 2. Shopify

### 2.1 API version strategy

Date-based versions, `YYYY-MM`. A new version every three months at the start
of the quarter. Each stable version is supported for **at least 12 months**,
with **at least 9 months of overlap** between consecutive versions.

**Decision:** pin one version in an environment variable, upgrade
deliberately. Never track "latest" — a silent quarterly schema change is a
silent breakage. The 9-month overlap gives ample room for a considered upgrade
once per year.

Current stable at time of writing: **2026-07**.

### 2.2 OAuth (authorization code grant)

1. Redirect to `https://{shop}/admin/oauth/authorize` with `client_id`,
   `scope`, `redirect_uri`, `state`.
2. `state` is a cryptographically random nonce stored in a **signed, httpOnly
   cookie**.
3. On callback, **three things must be validated before anything is trusted**:
   - `state` matches the stored nonce (CSRF).
   - **HMAC**: remove `hmac` from the query, sort the rest alphabetically,
     HMAC-SHA256 with the client secret, **constant-time compare**.
   - **Shop domain** matches `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$` —
     *anchored at both ends*. Without the trailing `$`,
     `evil.myshopify.com.attacker.example` passes.
4. Exchange the code at `POST https://{shop}/admin/oauth/access_token`.

**Token type:** offline access token. **New public apps must request expiring
tokens (`expiring=1`) and implement refresh before expiry.** This is a
material design consequence: the connection record needs a refresh token and an
expiry, and the sync engine needs a refresh path. A design that assumes a
permanent token will not pass review.

### 2.3 Scopes

| Scope | For |
| --- | --- |
| `read_orders` | Orders, line items, refunds, transactions — **last 60 days only** |
| `read_all_orders` | Orders older than 60 days. **Requires Shopify approval** |
| `read_products` | Products and variants |
| `read_inventory` | Inventory levels |
| `read_customers` | Customers — **protected customer data approval required** |
| `read_fulfillments` | Fulfilment status |

Write scopes are **not requested**. BizMind reads and advises; it does not
change a merchant's store. Requesting write access we do not use is a review
risk and a customer-trust risk.

**Two approvals are needed from Shopify and are outside our control:**
`read_all_orders`, and protected customer data access. Without the first,
history is capped at 60 days and the dashboard must say so rather than
presenting a partial year as a full one.

### 2.4 Rate limits

Leaky bucket, **calculated query cost**:

| Plan | Points/second | Bucket |
| --- | --- | --- |
| Standard | 100 | 100× rate |
| Advanced | 200 | |
| Plus | 1000 | |
| Enterprise | 2000 | |

Scalars and enums cost 0, objects 1, connections are sized by their arguments,
mutations 10 by default. Every response carries `extensions.cost` with
`requestedQueryCost`, `actualQueryCost`, and `throttleStatus`
(`maximumAvailable`, `currentlyAvailable`, `restoreRate`).

**Design:** the client reads `throttleStatus.currentlyAvailable` after every
call and paces itself — request the next page only when the bucket has room for
its estimated cost. On `THROTTLED`, back off starting at one second. This is
adaptive by construction and needs no hard-coded assumption about the
merchant's plan.

### 2.5 Pagination

Cursor-based: `pageInfo { hasNextPage, endCursor }`. `endCursor` is the
checkpoint the sync engine stores (Phase 10). Never page by offset — a store
mutating while we read would skip or duplicate rows.

**Initial sync — open question.** Shopify offers a Bulk Operations API
(`bulkOperationRunQuery`) that returns a JSONL file and is designed for exactly
this. It is almost certainly the right tool for a first sync of a large
catalogue, and it removes rate-limit pressure entirely. **It is listed as an
open decision (§11) because it has not been verified against the current
version.** Paged queries are the fallback and are certainly sufficient for a
small merchant.

### 2.6 Webhooks

| Header | Use |
| --- | --- |
| `X-Shopify-Hmac-SHA256` | base64 HMAC-SHA256 of the **raw body**, key = client secret |
| `X-Shopify-Webhook-Id` | Duplicate detection |
| `X-Shopify-Event-Id` | Correlating deliveries from one action |

**Verification: HMAC over the raw request body, before any middleware parses
it.** In a Next.js 16 route handler this means `await request.text()` and
verifying *that*, then parsing. Calling `request.json()` first destroys the
ability to verify, and no amount of re-serialising recovers it — key ordering
and whitespace will differ.

Compare with a timing-safe comparison.

**Delivery expectations:** 1-second connection timeout, **5-second overall
timeout**, must return `200`. Retries **8 times over 4 hours**; after 8
consecutive failures, an Admin-API-created subscription is **deleted**.

Five seconds is the whole design constraint for the webhook endpoint:
**verify, persist the raw event, return 200.** All processing happens
afterwards, in the Phase 10 engine. A handler that normalises and writes inline
will eventually exceed five seconds on a busy store and Shopify will
unsubscribe us.

Topics to subscribe: `orders/create`, `orders/updated`, `orders/cancelled`,
`refunds/create`, `products/create`, `products/update`, `products/delete`,
`inventory_levels/update`, `customers/create`, `customers/update`,
`app/uninstalled`.

### 2.7 Disconnect and reconnect

`app/uninstalled` marks the connection revoked and stops sync. **Business data
is kept.** A merchant who reconnects should find their history intact; a
merchant who wants it gone asks for deletion explicitly, which is an audited
action.

Reconnect re-runs OAuth and resumes from the stored cursor if the shop domain
matches, otherwise starts a fresh initial sync.

---

## 3. WooCommerce

### 3.1 API and authentication

Namespace `wc/v3`. Requires WooCommerce 3.5+ and WordPress 4.4+.

**Over HTTPS:** HTTP Basic Auth — consumer key as username, consumer secret as
password.

**Over plain HTTP:** OAuth 1.0a one-legged signing is mandatory.

**Decision: BizMind refuses a non-HTTPS store.** Supporting OAuth 1.0a signing
to accommodate a shop that transmits order data in clear text is engineering
effort spent making an insecure configuration usable. The connection form
rejects `http://` with an explanation.

Keys are generated by the owner at **WooCommerce → Settings → Advanced → REST
API** with **Read** permission. This is a manual step (§12).

### 3.2 Pagination

`?page=N&per_page=N` (default 10, max 100), or `?offset=N`. Responses carry
`X-WP-Total` and `X-WP-TotalPages`, plus a `Link` header with
`next`/`prev`/`first`/`last`.

**Risk:** page-number pagination over a mutating dataset can skip or repeat
rows. Mitigation: order by `id` ascending and use `?after=` on a date field
where available, checkpointing the highest id seen rather than the page number.

### 3.3 Rate limits

**WooCommerce defines none.** It is self-hosted, so the limit is whatever the
merchant's hosting imposes — and a shared-hosting store can be knocked over by
an aggressive sync.

**Design:** conservative default concurrency (1 request at a time), a
configurable delay, respect `Retry-After`, and treat `429`/`503` as backoff
signals. Being a considerate guest on someone else's server is a correctness
requirement here, not politeness.

### 3.4 Webhooks

| Header | Use |
| --- | --- |
| `X-WC-Webhook-Signature` | base64 HMAC-SHA256 of the payload body |
| `X-WC-Webhook-Topic` | e.g. `order.updated` |
| `X-WC-Webhook-Resource` | e.g. `order` |
| `X-WC-Webhook-Event` | e.g. `updated` |
| `X-WC-Webhook-ID` | The webhook's id |
| `X-WC-Webhook-Delivery-ID` | Delivery log id — the idempotency key |
| `X-WC-Webhook-Source` | Origin site URL — **must be checked against the connection** |

**The secret defaults to an MD5 of the current user's `id|username` if left
blank.** That is guessable. **BizMind must always generate and supply a strong
random secret** when creating the webhook, and store it alongside the
connection. A design that accepts the default is unauthenticated in practice.

Topics: `coupon`, `customer`, `order`, `product` × `created`, `updated`,
`deleted`.

**Failure behaviour:** after **5 consecutive non-2xx/301/302 responses the
webhook is disabled** and must be re-enabled through the REST API. The sync
engine must detect a disabled webhook and re-enable it, or the store goes
quietly stale.

### 3.5 Disconnect and reconnect

Delete our webhooks through the API, mark the connection revoked, keep the
data. If the merchant revoked the key on their side, deletion will fail — that
is expected and must not block disconnection.

---

## 4. Universal mapping

**No Shopify or WooCommerce tables.** Both connectors map into the existing
model: `orders`, `order_items`, `products`, `product_variants`, `customers`,
`inventory`, `payments`, `returns`, `channels`.

Every row already carries what is needed:

| Column | Carries |
| --- | --- |
| `business_id` | Tenant. Never from the request — always from the session or the verified connection |
| `source` | `SHOPIFY`, `WOOCOMMERCE` |
| `external_id` | The vendor's own id |
| `source_metadata` | The record as the vendor sent it |

The partial unique index `(business_id, source, external_id)` from migration
0002 is the idempotency key. Re-importing the same order updates it rather than
duplicating it — that mechanism is built and tested.

### 4.1 The semantics question this phase must answer

Phase 7.2 established that a source field may only feed a BizMind metric once a
**person** has confirmed what it means, enforced by database constraints.

A vendor-documented field is different from a seller's spreadsheet column:
Shopify's `totalPriceSet` has a published definition. That is documentation,
not inference — so the rule "never infer financial meaning from a similar
name" is not violated by using it.

But the constraint requires `confirmed_by` to be a real `profiles.id`, and a
connector is not a person.

**Recommended resolution (open decision §11):** at connect time, the wizard
shows the owner the connector's proposed mapping *with the vendor's own
definition beside each field*, and the owner confirms it in one action. The
constraint stays intact, a human stays accountable, and it happens once per
store rather than once per import.

The alternative — a system actor id — weakens the strongest guarantee in the
codebase to save one click. Not recommended.

### 4.2 Fields that must NOT be mapped casually

- Shopify's `totalPrice` vs `subtotalPrice` vs `currentTotalPrice` — the
  "current" variants are net of edits and refunds. Which one is revenue is a
  decision, not a lookup.
- Shopify presentment vs shop currency (`*Set` fields carry both). BizMind
  never converts currency. The shop-currency value is the one that matches the
  business's own books.
- WooCommerce `total` includes tax and shipping by configuration. `total_tax`
  and `shipping_total` exist separately.
- Refunds are negative in some payloads and positive in others. Sign
  convention is verified per connector, once, with a test.

---

## 5. Database changes

Two new tables. Neither holds a business figure.

```
integration_connections
  id, business_id, channel_type, external_shop_id, shop_domain,
  status (CONNECTED | REVOKED | ERROR),
  access_token_encrypted, refresh_token_encrypted, token_expires_at,
  webhook_secret_encrypted, scopes[], api_version,
  connected_by, connected_at, revoked_at, last_error

integration_webhook_subscriptions
  id, business_id, connection_id, topic, external_subscription_id,
  status, created_at
```

RLS on both, same four policies as every other tenant table. **Tokens are never
selectable by the browser**: the columns are excluded from every client-facing
select, and the service that reads them is server-only.

Encryption at rest is an open decision (§11) — Supabase encrypts the disk, but
a token is a bearer credential for someone else's store and deserves
column-level encryption with a key held outside the database.

---

## 6. API changes

| Route | Purpose |
| --- | --- |
| `GET /api/v1/integrations/shopify/install` | Begins OAuth. Business from session |
| `GET /api/v1/integrations/shopify/callback` | Validates state, HMAC, shop domain; exchanges code |
| `POST /api/v1/webhooks/shopify` | Verifies HMAC over raw body, persists, returns 200 |
| `POST /api/v1/webhooks/woocommerce` | Same, with the WooCommerce signature |
| Server actions | Connect/disconnect WooCommerce, list connections |

**The webhook routes are public by necessity** — the vendor calls them without
a session. Their only authentication is the signature, which is why the
verification must be exactly right and must precede everything else.

`business_id` is resolved from the **verified connection**, never from the
request body or a query parameter.

---

## 7. Security implications

- Tokens and secrets: server-only, never in a `NEXT_PUBLIC_` variable, never
  logged, never returned by an API route. The existing `verify-money-guard`
  pattern suggests a companion scanner that fails the build if a token column
  appears in a client component.
- Webhook endpoints are unauthenticated by design; signature verification is
  the whole security boundary. Verify **before** parsing, compare in constant
  time, and reject with 401 without explanation.
- A webhook names a shop. **The shop must be looked up against
  `integration_connections` to find the tenant.** An unrecognised shop is
  dropped. This is where cross-tenant contamination would happen if it happened
  anywhere.
- Replay: the vendor's delivery id is stored and a repeat is a no-op.
- Scope creep: request read scopes only.

---

## 8. RLS and tenant isolation

The webhook path has no user session, so it cannot rely on
`current_user_business_ids()`. Two options:

1. **Service-role write, restricted to a narrow function** — the ingestion
   function takes the connection id, resolves the tenant itself, and writes
   only within it.
2. A dedicated database role for the webhook path with its own policies.

CLAUDE.md forbids using the service-role key to serve a *user request*. A
verified vendor webhook is a trusted background job, which is the case that
rule explicitly allows — but the blast radius must be one function, not a
general-purpose client. **Open decision (§11).**

Tests must include: a webhook for business A's shop cannot write into business
B; a forged signature is rejected; an unknown shop is dropped.

---

## 9. Testing strategy

- **No fake credentials, no fake stores.** Contract tests run against recorded
  payloads (fixtures captured from a real development store, with customer
  data scrubbed).
- Signature verification tested against known-good and known-bad vectors,
  including a body altered by one byte.
- Idempotency: the same order delivered twice produces one row.
- Rate limiting: a simulated `THROTTLED` response backs off rather than
  hammering.
- Tenant isolation: as §8.
- A **live smoke test** against a Shopify development store and a local
  WooCommerce install, run by hand, documented, and never in CI with real
  credentials.

---

## 10. Official references

Consulted 2026-09-09:

- [Shopify Admin API](https://shopify.dev/docs/api/admin)
- [API versioning](https://shopify.dev/docs/api/usage/versioning)
- [All-in on GraphQL](https://www.shopify.com/partners/blog/all-in-on-graphql) — REST legacy since 1 Oct 2024
- [New public apps must use GraphQL from April 2025](https://shopify.dev/changelog/starting-april-2025-new-public-apps-submitted-to-shopify-app-store-must-use-graphql)
- [Rate limits](https://shopify.dev/docs/api/usage/rate-limits)
- [Access scopes](https://shopify.dev/docs/api/usage/access-scopes)
- [Authorization code grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant)
- [HTTPS webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe/https)
- [WooCommerce REST API v3](https://woocommerce.github.io/woocommerce-rest-api-docs/)
- [WooCommerce webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/)
- [WooCommerce webhooks (user docs)](https://woocommerce.com/document/webhooks/)

---

## 11. Open decisions

1. **Bulk Operations for initial sync** — likely correct, unverified.
2. **Connector semantics confirmation** — one owner confirmation at connect
   time (recommended) vs a system actor id (weakens the gate).
3. **Token encryption at rest** — column-level encryption with an external key,
   or rely on Supabase disk encryption.
4. **Webhook write path** — narrow service-role function vs a dedicated role.
5. **Shopify app type** — public (app store, needs review and both approvals)
   vs custom (per-merchant, no review, no distribution). This decides whether
   the approvals in §2.3 are needed at all.
6. **Order-of-truth for revenue** — which Shopify total is BizMind revenue.
   Must be decided once, tested, and documented in MAPPING.md.

---

## 12. Manual steps for the owner

**Shopify**
1. Create a Shopify Partner account.
2. Create the app; record client id and client secret.
3. Set the redirect URI to the deployed callback.
4. Request `read_all_orders` approval (for history beyond 60 days).
5. Request protected customer data access.
6. Create a development store for testing.

**WooCommerce**
1. On the store: WooCommerce → Settings → Advanced → REST API → Add key,
   permission **Read**.
2. Copy consumer key and secret **once** — they are not shown again.
3. Confirm the store is HTTPS.

**Both:** paste credentials into BizMind's connection screen, never into chat.

---

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Building on REST | Settled: GraphQL only |
| Token expiry unhandled | Refresh path designed in from the start |
| Webhook handler too slow | Verify, persist, 200. Process in Phase 10 |
| WooCommerce default webhook secret | Always supply our own |
| Shared hosting overwhelmed | Conservative, configurable pacing |
| 60-day order cap | Surfaced in the UI, not hidden |
| Quarterly API version churn | Pinned version, deliberate annual upgrade |
| Cross-tenant webhook write | Shop → connection → tenant, tested by attack |

---

## 14. Cost and scalability

Shopify and WooCommerce charge nothing for API access. Cost is compute and
database. The dominant load is initial sync; steady state is webhook-driven and
cheap. Bulk Operations, if adopted, moves the heavy read onto Shopify's side.

Scaling is per-connection: adding merchants adds independent work, and the
Phase 10 engine is where concurrency is bounded.

---

## 15. Rollback

Every step is reversible without data loss:

- Migration adds tables only; a down-migration drops them.
- Disconnecting revokes tokens and deletes webhooks; imported data remains and
  keeps working exactly as file-imported data does.
- The connector is additive — nothing in the existing pipeline changes, so a
  broken connector cannot break the file importer or the dashboard.
