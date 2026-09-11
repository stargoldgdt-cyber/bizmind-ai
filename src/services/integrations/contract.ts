/**
 * The connector contract.
 *
 * THE DIVIDING LINE
 * -----------------
 * A connector knows one provider's API and nothing else. The engine knows
 * scheduling, retries, idempotency, logging, sync state, failure handling and
 * tenant safety, and knows nothing about any provider.
 *
 *   Connector   how to ask Shopify for a page of orders, and what its
 *               signature header means
 *
 *   Engine      when to ask, what to do when it fails, how to be sure the
 *               same order is not written twice, and whose data it is
 *
 * Mixing them is how the sixth integration becomes as expensive as the first.
 * A connector that retries, or schedules, or decides a tenant, has taken a job
 * that belongs to the engine -- and taken it six times over.
 *
 * WHAT A CONNECTOR MAY NOT DO
 * ---------------------------
 * - Write to a business table. It returns `RawRecord`s; the existing ingestion
 *   pipeline writes them, exactly as the CSV importer does.
 * - Calculate a financial figure. Not a total, not a margin, not a conversion.
 *   Money is calculated in SQL (MONEY.md) and a connector is nowhere near SQL.
 * - Decide which business a record belongs to. The engine resolves that from a
 *   connection row and passes nothing to the connector that could influence it.
 * - Retry. Returning a failure is how a connector asks for a retry; the engine
 *   decides whether and when.
 */

import type { RawRecord } from "@/services/ingestion/contracts"

/** Providers the engine can host. Mirrors the database enum. */
export type IntegrationProvider = "FIXTURE" | "WOOCOMMERCE" | "SHOPIFY" | "GOOGLE_SHEETS"

/** What a connector can be asked to fetch. Mirrors the `resource` check. */
export type SyncResource = "ORDERS" | "PRODUCTS" | "CUSTOMERS" | "INVENTORY" | "EXPENSES"

export type SyncMode = "INITIAL" | "INCREMENTAL"

/**
 * Credentials, already decrypted, handed to a connector for one call.
 *
 * Deliberately opaque: the engine never inspects these, and a connector never
 * stores them. They exist for the duration of a request.
 */
export type ConnectorCredentials = Record<string, string>

/** Everything a connector needs, and nothing it does not. */
export type ConnectorContext = {
  /** The provider's stable identity for this store. */
  externalAccountId: string
  credentials: ConnectorCredentials
  /** Non-sensitive connection facts: API version, site URL, store name. */
  metadata: Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of asking a provider for one page.
 *
 * A discriminated union rather than an exception, because "rate limited" and
 * "your token expired" and "their server fell over" call for three different
 * decisions, and an exception flattens all three into one.
 */
export type FetchResult =
  | {
      kind: "page"
      records: RawRecord[]
      /**
       * Present for TABLE-SHAPED sources such as a spreadsheet, whose records
       * are keyed by the source's own column headings rather than by BizMind's
       * canonical names. The worker then applies the owner's confirmed mapping
       * through the same `validate()` the CSV importer uses -- there is one
       * mapping engine, not one per source.
       */
      table?: {
        /** The heading row as it stands right now, for mapping-change checks. */
        headers: string[]
        /** The sheet row each record came from. Lineage only, never an identity. */
        rowNumbers: number[]
      }
      /** Opaque checkpoint. Written only after these records are applied. */
      nextCursor: string | null
      /** False when this was the last page. */
      hasMore: boolean
    }
  | {
      kind: "rate_limited"
      /**
       * How long the provider asked us to wait.
       *
       * The connector reports the signal; the ENGINE decides what to do with
       * it. This is the seam that keeps Shopify's leaky-bucket arithmetic out
       * of a scheduler that also serves WooCommerce.
       */
      retryAfterMs: number
      reason: string
    }
  | {
      kind: "retryable_error"
      /** A timeout, a 500, a dropped connection. Worth trying again. */
      reason: string
    }
  | {
      kind: "permanent_error"
      /**
       * A revoked token, a deleted store, a malformed request of ours.
       * Retrying cannot fix it, so the engine must not waste seven attempts
       * discovering that -- it goes straight to a state a person can see.
       */
      reason: string
      /**
       * What a person must do about it, when the connector can tell. The
       * worker turns this into the connection's state, so an owner is shown
       * "reconnect Google" rather than a generic error.
       */
      code?: "REAUTH_REQUIRED" | "MAPPING_REVIEW_REQUIRED" | "SOURCE_GONE" | "ACCESS_DENIED"
    }

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a connector extracts from a delivery, before anything is trusted.
 *
 * Note what is absent: no business id, no tenant, no connection. A connector
 * reports which STORE the provider says this is; the engine turns that into a
 * tenant by looking it up. A connector that could name a tenant would be a
 * connector that could be tricked into naming the wrong one.
 */
export type WebhookIdentity = {
  /** The provider's stable store identity, from a header or the path. */
  externalAccountId: string
  /** The provider's delivery id. The idempotency key. */
  externalEventId: string
  /** `orders/create`, `order.updated`. Provider vocabulary, kept verbatim. */
  eventType: string
}

export type WebhookParseResult =
  | { kind: "identified"; identity: WebhookIdentity }
  | { kind: "unparseable"; reason: string }

/* -------------------------------------------------------------------------- */
/* The connector                                                              */
/* -------------------------------------------------------------------------- */

export type Connector = {
  provider: IntegrationProvider

  /** The channel type sales from this provider are attributed to. */
  channelType: string

  /** Resources this connector can sync. The engine schedules only these. */
  resources: readonly SyncResource[]

  /**
   * Confirms the credentials work, before a connection is saved.
   *
   * Called at connect time so a merchant learns their key is wrong while they
   * are looking at the form, rather than three days later when a figure is
   * missing.
   */
  validateConnection(context: ConnectorContext): Promise<
    { ok: true; displayName: string; metadata: Record<string, unknown> } | { ok: false; reason: string }
  >

  /**
   * Fetches one page.
   *
   * `cursor` is whatever this connector last returned, replayed verbatim. The
   * engine never interprets it.
   */
  fetchPage(input: {
    context: ConnectorContext
    resource: SyncResource
    mode: SyncMode
    cursor: string | null
  }): Promise<FetchResult>

  /**
   * Identifies a delivery from its headers and raw body.
   *
   * Runs BEFORE verification, and its output is therefore untrusted: it names
   * a store the engine must then look up.
   */
  parseWebhook(input: {
    headers: Record<string, string>
    rawBody: string
  }): WebhookParseResult

  /**
   * Verifies the signature over the EXACT RAW BODY.
   *
   * The body is passed as the string it arrived as. Re-serialising a parsed
   * object produces different bytes -- different key order, different
   * whitespace -- and the signature will never match, which is a bug that
   * looks like an attack.
   *
   * Implementations must compare in constant time. `signaturesMatch()` in
   * `src/lib/crypto.ts` is the helper for that.
   */
  verifyWebhook(input: {
    headers: Record<string, string>
    rawBody: string
    secret: string
  }): boolean

  /**
   * Turns a delivery into records for the ingestion pipeline.
   *
   * Returns an empty array for an event that carries no data worth applying --
   * a test ping, an event type we do not act on.
   */
  parseWebhookRecords(input: {
    eventType: string
    rawBody: string
  }): { resource: SyncResource; records: RawRecord[] } | null
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const registry = new Map<IntegrationProvider, Connector>()

export function registerConnector(connector: Connector): void {
  registry.set(connector.provider, connector)
}

export function getConnector(provider: string): Connector | null {
  return registry.get(provider as IntegrationProvider) ?? null
}

export function registeredProviders(): IntegrationProvider[] {
  return [...registry.keys()]
}

/** Whether a string names a provider the engine knows. */
export function isKnownProvider(value: string): value is IntegrationProvider {
  return (
    value === "FIXTURE" ||
    value === "WOOCOMMERCE" ||
    value === "SHOPIFY" ||
    value === "GOOGLE_SHEETS"
  )
}
