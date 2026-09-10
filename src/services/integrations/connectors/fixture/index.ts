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

/**
 * The fixture connector.
 *
 * THIS IS NOT A FAKE INTEGRATION AND IT PRODUCES NO PRODUCTION DATA.
 *
 * It exists to prove the engine. Every hard behaviour a real provider will
 * eventually inflict on us -- a rate limit, a 500 that clears, a revoked
 * token, a page that repeats a record, a redelivered webhook, a forged
 * signature -- can be produced here on demand, deterministically, with no
 * network, no credentials, and no vendor account.
 *
 * That matters for a reason worth stating plainly: OAuth approvals, developer
 * accounts and store provisioning are outside our control and take days. The
 * retry schedule, the idempotency guarantee and the tenant boundary are not,
 * and they are the parts that must be right. Proving them against a connector
 * we fully control means the first real integration is debugging one system
 * rather than two.
 *
 * Behaviour is chosen by the `scenario` in a connection's metadata, so a test
 * asks for the failure it wants rather than waiting for one.
 */

export type FixtureScenario =
  | "happy"
  | "rate_limited_once"
  | "transient_error_once"
  | "permanent_error"
  | "duplicates"
  | "partial"

const PAGE_SIZE = 2
const TOTAL_PAGES = 3

/** Header names, chosen to mirror the shape real providers use. */
export const FIXTURE_HEADERS = {
  account: "x-fixture-account",
  delivery: "x-fixture-delivery",
  topic: "x-fixture-topic",
  signature: "x-fixture-signature",
} as const

/**
 * Deterministic call counting.
 *
 * A scenario like "fail once, then succeed" needs to know it has already
 * failed. Keyed by account and resource so two businesses syncing at the same
 * time do not perturb each other's scenario -- which is itself one of the
 * things the engine tests must be able to trust.
 */
const attempts = new Map<string, number>()

function attemptKey(context: ConnectorContext, resource: SyncResource): string {
  return `${context.externalAccountId}:${resource}`
}

/** Test hook. Resets the deterministic counters between scenarios. */
export function resetFixtureState(): void {
  attempts.clear()
}

export function fixtureAttemptCount(
  externalAccountId: string,
  resource: SyncResource
): number {
  return attempts.get(`${externalAccountId}:${resource}`) ?? 0
}

function scenarioOf(context: ConnectorContext): FixtureScenario {
  const value = context.metadata?.scenario
  return typeof value === "string" ? (value as FixtureScenario) : "happy"
}

/** Cursors are opaque to the engine; here they are simply "page-N". */
function pageOf(cursor: string | null): number {
  if (cursor === null) return 0
  const parsed = Number.parseInt(cursor.replace("page-", ""), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * One page of orders.
 *
 * The records are shaped for the existing ingestion pipeline -- the same
 * `RawRecord` a CSV row produces -- because a connector's whole job is to
 * reach that pipeline, not to bypass it.
 */
function ordersPage(page: number, options: { duplicate?: boolean; malformed?: boolean }): RawRecord[] {
  const base = page * PAGE_SIZE

  const records: RawRecord[] = Array.from({ length: PAGE_SIZE }, (_, index) => {
    const n = base + index + 1
    return {
      external_id: `FIX-${n}`,
      placed_at: `2026-05-${String((n % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      status: "FULFILLED",
      currency: "AED",
      total: "100.0000",
      fee_total: "5.0000",
      items: [
        {
          sku: `FIX-SKU-${n}`,
          name: `Fixture item ${n}`,
          quantity: "1",
          unit_price: "100.0000",
          unit_cost: "40.0000",
          line_total: "100.0000",
        },
      ],
    }
  })

  // A provider repeating a record across pages is ordinary, not exotic:
  // anything ordered by an updated_at that ticks during a sync will do it.
  // The engine must not write it twice, and the existing
  // (business_id, source, external_id) index is what guarantees that.
  if (options.duplicate && page > 0) {
    records.push({ ...(records[0] as RawRecord) })
  }

  // A single unusable row in an otherwise good page. The engine must apply the
  // rest rather than discarding 250 good orders because one was broken.
  if (options.malformed && page === 1) {
    records.push({
      external_id: `FIX-MALFORMED-${page}`,
      placed_at: "not-a-date",
      status: "FULFILLED",
      currency: "AED",
      total: "not-a-number",
      items: [],
    })
  }

  return records
}

export const fixtureConnector: Connector = {
  provider: "FIXTURE",

  // Deliberately not a new channel_type. A test-only concept has no business
  // widening a production enum that analytics groups by.
  channelType: "OTHER",

  resources: ["ORDERS"],

  async validateConnection(context) {
    if (scenarioOf(context) === "permanent_error") {
      return { ok: false, reason: "Fixture scenario refuses to validate." }
    }

    if (context.credentials.api_key !== "fixture-key") {
      return { ok: false, reason: "Fixture credentials are not valid." }
    }

    return {
      ok: true,
      displayName: `Fixture store ${context.externalAccountId}`,
      metadata: { scenario: scenarioOf(context) },
    }
  },

  async fetchPage({ context, resource, cursor }): Promise<FetchResult> {
    const scenario = scenarioOf(context)
    const key = attemptKey(context, resource)
    const attempt = (attempts.get(key) ?? 0) + 1
    attempts.set(key, attempt)

    if (scenario === "permanent_error") {
      return {
        kind: "permanent_error",
        reason: "Fixture credentials were revoked.",
      }
    }

    // Both of these clear on the second attempt, which is what makes them
    // useful: a test can assert the engine RECOVERED, not merely that it gave
    // up politely.
    if (scenario === "rate_limited_once" && attempt === 1) {
      return {
        kind: "rate_limited",
        retryAfterMs: 1_000,
        reason: "Fixture rate limit.",
      }
    }

    if (scenario === "transient_error_once" && attempt === 1) {
      return {
        kind: "retryable_error",
        reason: "Fixture upstream returned 500.",
      }
    }

    const page = pageOf(cursor)

    if (page >= TOTAL_PAGES) {
      return { kind: "page", records: [], nextCursor: cursor, hasMore: false }
    }

    return {
      kind: "page",
      records: ordersPage(page, {
        duplicate: scenario === "duplicates",
        malformed: scenario === "partial",
      }),
      nextCursor: `page-${page + 1}`,
      hasMore: page + 1 < TOTAL_PAGES,
    }
  },

  parseWebhook({ headers }): WebhookParseResult {
    const account = headers[FIXTURE_HEADERS.account]
    const delivery = headers[FIXTURE_HEADERS.delivery]
    const topic = headers[FIXTURE_HEADERS.topic]

    // A delivery we cannot even identify is dropped before anything else
    // happens. There is nothing to look up and nothing to verify against.
    if (!account || !delivery || !topic) {
      return {
        kind: "unparseable",
        reason: "Fixture delivery is missing its account, delivery or topic header.",
      }
    }

    return {
      kind: "identified",
      identity: {
        externalAccountId: account,
        externalEventId: delivery,
        eventType: topic,
      },
    }
  },

  verifyWebhook({ headers, rawBody, secret }): boolean {
    const provided = headers[FIXTURE_HEADERS.signature]
    if (!provided) return false

    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64")

    return signaturesMatch(expected, provided)
  },

  parseWebhookRecords({ eventType, rawBody }) {
    if (eventType !== "orders/create" && eventType !== "orders/updated") return null

    try {
      const parsed: unknown = JSON.parse(rawBody)
      if (typeof parsed !== "object" || parsed === null) return null

      const order = parsed as RawRecord
      if (typeof order.external_id !== "string") return null

      return { resource: "ORDERS", records: [order] }
    } catch {
      // A body that verified but will not parse is a real possibility, and it
      // is a processing failure rather than a security one.
      return null
    }
  },
}

/** Signs a body the way the fixture provider would. Used only by tests. */
export function signFixturePayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64")
}
