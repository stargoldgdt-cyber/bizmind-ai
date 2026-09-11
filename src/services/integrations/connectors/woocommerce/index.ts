import { createHmac } from "node:crypto"

import { signaturesMatch } from "@/lib/crypto"
import type { RawRecord } from "@/services/ingestion/contracts"
import type {
  Connector,
  ConnectorContext,
  FetchResult,
  SyncResource,
  WebhookParseResult,
} from "@/services/integrations/contract"

import { checkSiteUrl, wooGet, type WooCredentials } from "./client"
import {
  isImportableOrder,
  isImportableProduct,
  mapOrder,
  mapProduct,
} from "./mapper"

/**
 * The WooCommerce connector.
 *
 * Provider-specific behaviour only. Scheduling, retries, idempotency, tenant
 * safety and failure handling belong to the engine, and none of them appear
 * here -- a rate limit is REPORTED, not handled.
 *
 * Official documentation consulted 2026-09-09:
 *   https://woocommerce.github.io/woocommerce-rest-api-docs/
 *   https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks/
 */

/** Modest on purpose. The store is somebody's own server. */
const PAGE_SIZE = 50

export const WOO_HEADERS = {
  source: "x-wc-webhook-source",
  topic: "x-wc-webhook-topic",
  resource: "x-wc-webhook-resource",
  event: "x-wc-webhook-event",
  signature: "x-wc-webhook-signature",
  webhookId: "x-wc-webhook-id",
  deliveryId: "x-wc-webhook-delivery-id",
} as const

/**
 * The cursor.
 *
 * `page` walks the catalogue. `modifiedAfter` is set once a full pass
 * finishes, so the next incremental run asks only for what changed.
 *
 * Opaque to the engine, which stores and replays it without looking inside.
 */
type WooCursor = { page: number; modifiedAfter: string | null }

function readCursor(cursor: string | null): WooCursor {
  if (cursor === null) return { page: 1, modifiedAfter: null }

  try {
    const parsed: unknown = JSON.parse(cursor)
    if (typeof parsed !== "object" || parsed === null) {
      return { page: 1, modifiedAfter: null }
    }

    const record = parsed as { page?: unknown; modifiedAfter?: unknown }
    return {
      page: typeof record.page === "number" && record.page >= 1 ? record.page : 1,
      modifiedAfter:
        typeof record.modifiedAfter === "string" ? record.modifiedAfter : null,
    }
  } catch {
    // A cursor we cannot read is a cursor we start over from. The
    // (business_id, source, external_id) index makes re-reading harmless.
    return { page: 1, modifiedAfter: null }
  }
}

function writeCursor(cursor: WooCursor): string {
  return JSON.stringify(cursor)
}

function credentialsOf(context: ConnectorContext): WooCredentials {
  return {
    consumer_key: context.credentials.consumer_key ?? "",
    consumer_secret: context.credentials.consumer_secret ?? "",
  }
}

/** The store address is the account's stable identity. */
function siteUrlOf(context: ConnectorContext): string {
  return context.externalAccountId
}

/**
 * Which WooCommerce endpoint serves each resource.
 *
 * Partial on purpose: WooCommerce has no expenses, and a made-up endpoint
 * would be a lie waiting for a caller. The engine only schedules the resources
 * listed in `resources` below, and anything else is refused plainly in
 * fetchPage().
 */
const ENDPOINT: Partial<Record<SyncResource, string>> = {
  ORDERS: "orders",
  PRODUCTS: "products",
  CUSTOMERS: "customers",
  INVENTORY: "products",
}

export const wooCommerceConnector: Connector = {
  provider: "WOOCOMMERCE",
  channelType: "WOOCOMMERCE",

  // Customers arrive attached to their orders, which is where they matter for
  // analytics. A dedicated customer sync is worth adding when there is a
  // reason to read customers who have never ordered.
  resources: ["ORDERS", "PRODUCTS"],

  async validateConnection(context) {
    const site = checkSiteUrl(siteUrlOf(context))
    if (!site.ok) return { ok: false, reason: site.reason }

    const credentials = credentialsOf(context)
    if (!credentials.consumer_key || !credentials.consumer_secret) {
      return { ok: false, reason: "Both the consumer key and the consumer secret are needed." }
    }

    // One cheap, read-only call. A wrong key should be found while the owner
    // is looking at the form, not three days later when a figure is missing.
    const response = await wooGet({
      siteUrl: site.origin,
      credentials,
      path: "orders",
      query: { per_page: 1 },
    })

    if (response.kind === "permanent_error") {
      return { ok: false, reason: response.reason }
    }

    if (response.kind !== "ok") {
      return {
        ok: false,
        reason: "The store could not be reached just now. Try again in a moment.",
      }
    }

    return {
      ok: true,
      displayName: new URL(site.origin).hostname,
      metadata: { site_url: site.origin, api_version: "wc/v3" },
    }
  },

  async fetchPage({ context, resource, mode, cursor }): Promise<FetchResult> {
    const site = checkSiteUrl(siteUrlOf(context))
    if (!site.ok) return { kind: "permanent_error", reason: site.reason }

    const position = readCursor(cursor)

    const query: Record<string, string | number> = {
      per_page: PAGE_SIZE,
      page: position.page,
      // Ordering by id ascending keeps paging as stable as page numbers allow:
      // new records get higher ids and land at the end rather than shifting
      // the pages already read.
      orderby: "id",
      order: "asc",
    }

    if (resource === "ORDERS") {
      // Every status the store has. Without this WooCommerce returns only a
      // default subset, and cancelled orders would silently never arrive --
      // which matters, because analytics counts them separately.
      query.status = "any"
    }

    if (mode === "INCREMENTAL" && position.modifiedAfter !== null) {
      query.modified_after = position.modifiedAfter
    }

    const startedAt = new Date().toISOString()

    const path = ENDPOINT[resource]
    if (!path) {
      return {
        kind: "permanent_error",
        reason: `WooCommerce has no ${resource.toLowerCase()} to sync.`,
      }
    }

    const response = await wooGet({
      siteUrl: site.origin,
      credentials: credentialsOf(context),
      path,
      query,
    })

    if (response.kind === "rate_limited") {
      return {
        kind: "rate_limited",
        retryAfterMs: response.retryAfterMs,
        reason: response.reason,
      }
    }

    if (response.kind === "retryable_error") {
      return { kind: "retryable_error", reason: response.reason }
    }

    if (response.kind === "permanent_error") {
      return { kind: "permanent_error", reason: response.reason }
    }

    const records: RawRecord[] =
      resource === "PRODUCTS" || resource === "INVENTORY"
        ? response.body
            .filter(isImportableProduct)
            .map(mapProduct)
            .filter((row): row is RawRecord => row !== null)
        : response.body
            .filter(isImportableOrder)
            .map(mapOrder)
            .filter((row): row is RawRecord => row !== null)

    // A short page means the end, whether or not the store sent a page count:
    // WooCommerce omits X-WP-TotalPages on some configurations, and treating a
    // missing header as "keep going" would loop forever.
    const lastPage =
      response.body.length < PAGE_SIZE ||
      (response.totalPages !== null && position.page >= response.totalPages)

    if (lastPage) {
      // The pass is finished, so the next incremental run starts from when
      // THIS pass began -- not from now. Anything modified while we were
      // reading is picked up next time rather than missed.
      return {
        kind: "page",
        records,
        nextCursor: writeCursor({ page: 1, modifiedAfter: startedAt }),
        hasMore: false,
      }
    }

    return {
      kind: "page",
      records,
      nextCursor: writeCursor({
        page: position.page + 1,
        modifiedAfter: position.modifiedAfter,
      }),
      hasMore: true,
    }
  },

  parseWebhook({ headers }): WebhookParseResult {
    const source = headers[WOO_HEADERS.source]
    const delivery = headers[WOO_HEADERS.deliveryId]
    const topic = headers[WOO_HEADERS.topic]

    if (!source || !delivery || !topic) {
      return {
        kind: "unparseable",
        reason: "The delivery is missing its source, delivery id or topic header.",
      }
    }

    // The store names itself, and that name is the account identity the engine
    // looks up. Normalised to an origin so a trailing slash or a path does not
    // produce a store we have never heard of.
    const site = checkSiteUrl(source)
    if (!site.ok) {
      return { kind: "unparseable", reason: "The delivery's source address is not usable." }
    }

    return {
      kind: "identified",
      identity: {
        externalAccountId: site.origin,
        externalEventId: delivery,
        eventType: topic,
      },
    }
  },

  verifyWebhook({ headers, rawBody, secret }): boolean {
    const provided = headers[WOO_HEADERS.signature]
    if (!provided) return false

    // base64 HMAC-SHA256 of the payload body, per WooCommerce's own docs.
    //
    // The secret is ALWAYS one BizMind generated. WooCommerce defaults it to
    // an MD5 of the current user's `id|username` when left blank -- guessable,
    // which would make this check decorative.
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64")

    return signaturesMatch(expected, provided)
  },

  parseWebhookRecords({ eventType, rawBody }) {
    // `order.created`, `order.updated`. Deletions are not applied: an order
    // removed from WooCommerce is not evidence that it never happened, and
    // erasing history on a webhook is not a decision to make automatically.
    if (eventType !== "order.created" && eventType !== "order.updated") return null

    try {
      const parsed: unknown = JSON.parse(rawBody)
      if (!isImportableOrder(parsed)) return null

      const order = mapOrder(parsed)
      if (order === null) return null

      return { resource: "ORDERS", records: [order] }
    } catch {
      // A body that verified but will not parse is a processing failure, not a
      // security one. The engine retries it.
      return null
    }
  },
}

/** Signs a body the way WooCommerce would. Used only by tests. */
export function signWooPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64")
}
