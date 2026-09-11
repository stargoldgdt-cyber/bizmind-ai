# WooCommerce

**Built and tested. Not yet run against a real store.**

> **Correction — migration 0018.** Until 0018, no WooCommerce record could
> reach the database. The sync and webhook write functions created a batch with
> `file_type = 'api'`, which the database's own rule refused, so every write
> rolled back. No test ever called them with real rows, which is how it hid.
> What *was* tested here — mapping, signature verification, SSRF refusal — was
> genuinely tested; the database write was not. Section 6b of
> `npm run test:integration-live` now covers it, and synced orders now carry
> the connection's channel.

The first real connector on the engine described in
[INTEGRATION_ENGINE.md](INTEGRATION_ENGINE.md). Nothing in the engine changed
to accommodate it, which was the point of building the engine first.

Official documentation consulted 2026-09-09:
[REST API v3](https://woocommerce.github.io/woocommerce-rest-api-docs/) ·
[Webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/)

---

## 1. The two things a WooCommerce merchant must be told

### WooCommerce does not know what anything cost

WooCommerce core stores **no purchase cost**. So `unit_cost` is null on every
line BizMind imports, which means **gross profit and margin are overstated**
for these orders until costs arrive another way — a CSV import, or a costing
plugin we do not read.

This is not a gap to paper over. The cost-coverage figure already says it on
every screen that shows a margin, and the AI refuses to recommend anything
resting on it.

### There are no marketplace fees, because there is no marketplace

The merchant owns the store. `fee_lines` exists, but it holds seller-defined
surcharges whose meaning nobody has established — Phase 7.2's rule applies: a
field is not a fee because it is called one. Left null, so fee coverage
reports the gap rather than a confident zero.

---

## 2. Authentication

`wc/v3`, HTTP Basic over HTTPS: consumer key as username, consumer secret as
password. Requires WooCommerce 3.5+ and WordPress 4.4+.

**Stores served over plain HTTP are refused.** WooCommerce documents OAuth 1.0a
one-legged signing for them; supporting it would be effort spent making an
insecure configuration usable, and the merchant would be worse off for our
helpfulness — their orders and their API keys travel in the clear either way.

### The store address is untrusted input

A connection form that takes a URL and then fetches it is a server-side request
forgery hole unless something stops it. `checkSiteUrl()` refuses loopback,
private ranges, link-local (including `169.254.169.254`, the cloud metadata
address), `.local`, `.internal`, and credentials embedded in the URL.

It also reduces the address to its **origin**, because pasting the whole
browser address bar is the normal mistake and
`…/wp-admin/edit.php` should not become the API root.

Redirects are **not followed** (`redirect: "manual"`). A redirect would carry
the `Authorization` header to a host the owner never named.

---

## 3. Rate limits

**WooCommerce defines none.** It is self-hosted, so the real limit is whatever
the merchant's hosting imposes — and a shared-hosting store can be knocked over
by an aggressive sync.

Being a considerate guest on someone else's server is a correctness requirement
here, not politeness: a store we take down stops selling.

So: 50 records a page, one request at a time, `Retry-After` respected, and
`429`/`503` reported to the engine as a **rate limit rather than a failure** —
which means the attempt is refunded rather than counted toward the retry limit.

---

## 4. Pagination and cursors

`page` + `per_page`, ordered `id` ascending so new records land at the end
rather than shifting pages already read. `X-WP-TotalPages` is used when the
store sends it, and **a short page ends the pass either way** — some
configurations omit the header, and treating that as "keep going" would loop
forever.

The cursor is `{"page":N,"modifiedAfter":"…"}`, opaque to the engine.

When a full pass finishes, `modifiedAfter` is set to **when that pass began**,
not to now. Anything modified while we were reading is picked up next time
rather than missed.

`status=any` is sent for orders. Without it WooCommerce returns a default
subset and cancelled orders would silently never arrive — which matters,
because analytics counts them separately.

---

## 5. Webhooks

| Header | Use |
| --- | --- |
| `X-WC-Webhook-Source` | The store, normalised to an origin. The account identity |
| `X-WC-Webhook-Delivery-ID` | The idempotency key |
| `X-WC-Webhook-Topic` | `order.updated` |
| `X-WC-Webhook-Signature` | base64 HMAC-SHA256 of the payload body |

**BizMind always generates its own webhook secret.** WooCommerce defaults it to
an MD5 of the current user's `id|username` when left blank — guessable, which
would make verification decorative.

Verification is over the **raw bytes**, in constant time. A re-serialised body
fails, which is why the route never calls `request.json()` first.

**Deletions are not applied.** An order removed from WooCommerce is not
evidence that it never happened, and erasing history on a webhook is not a
decision to make automatically.

WooCommerce **disables a webhook after 5 consecutive non-2xx responses**, so
the receiver returns `200` for a duplicate rather than an error — providers
retry by design, and punishing a retry is how a healthy integration gets itself
switched off.

---

## 6. Mapping decisions

Each of these is a decision, not a name match.

| WooCommerce | BizMind | Why |
| --- | --- | --- |
| `total` | `total` | What the customer paid, including tax and shipping |
| — | `subtotal` | **Null.** Deriving it would be arithmetic on money in TypeScript |
| `total_tax`, `shipping_total`, `discount_total` | same | Carried verbatim |
| `fee_lines` | — | **Null.** See §1 |
| `line_items[].price` | `unit_price` | Per-unit, as sent |
| — | `unit_cost` | **Null.** See §1 |
| — | line `discount` | **Null.** `subtotal - total` is a subtraction |
| `date_created_gmt` | `placed_at` | **`Z` appended** — see below |

### Statuses

| WooCommerce | BizMind | Why |
| --- | --- | --- |
| `pending`, `on-hold` | `PENDING` | The money has not been taken |
| `processing` | `CONFIRMED` | |
| `completed` | `FULFILLED` | |
| `cancelled`, `failed` | `CANCELLED` | A failed payment is not an order waiting to happen |
| `refunded` | `REFUNDED` | |
| unknown | `PENDING` | A plugin status is not invented into revenue |
| `checkout-draft`, `trash` | *skipped* | Not orders |

`on-hold` as `PENDING` and `failed` as `CANCELLED` are the two worth arguing
about. Both keep money out of revenue that has not actually arrived — and
`CANCELLED` and `REFUNDED` are excluded by `analytics_counted_orders()`, so
getting them wrong would move real figures.

### Timestamps

WooCommerce sends GMT **with no zone suffix** — `2026-05-01T09:00:00`. Read
as-is it would be interpreted in the server's local time, and every order would
land in the wrong period for anyone outside UTC. A `Z` is appended.

### Money is never parsed

WooCommerce sends money as decimal strings. They are carried through
**character for character**: parsing one into a JavaScript number and printing
it again would reintroduce the floating-point conversion migration 0011 removed
from the rest of the product.

An empty string becomes **null, not "0"** — WooCommerce sends `""` for a field
it has no value for, and reading that as zero would state a fact the store
never stated.

---

## 7. What is not built yet

- **Customers** as their own resource. They arrive attached to orders, which is
  where they matter for analytics; a dedicated sync is worth adding when there
  is a reason to read customers who have never ordered.
- **Refunds** into the `returns` table.
- **Automatic webhook registration** at connect time.
- **Inventory** beyond the stock figure carried on a product.

---

## 8. Tests

```bash
npm run test:woocommerce
```

90 assertions, no network. Every payload is shaped as `wc/v3` documents its
responses.

**The interesting assertions are the negative ones**: subtotal null, fee null,
unit_cost null, line discount null, an empty money field null rather than zero,
a non-numeric one refused rather than coerced. A connector that quietly filled
those with plausible arithmetic would produce a margin that looks right and is
not — which is the failure this whole product is built to avoid.

Also covered: eight SSRF hosts refused, plain HTTP refused, redirects not
followed, signature verification including a one-byte change and a
re-serialised body, deletions not applied, and static checks that the connector
performs no money arithmetic and does not retry.
