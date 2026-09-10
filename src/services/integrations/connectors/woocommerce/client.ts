/**
 * The WooCommerce REST transport.
 *
 * Namespace `wc/v3`. Requires WooCommerce 3.5+ and WordPress 4.4+.
 *
 * AUTHENTICATION
 * --------------
 * HTTP Basic over HTTPS: the consumer key is the username and the consumer
 * secret is the password. WooCommerce also documents OAuth 1.0a one-legged
 * signing for stores served over plain HTTP.
 *
 * BizMind refuses those stores outright. Supporting a signing scheme so that a
 * shop can transmit its customers' orders in clear text is effort spent making
 * an insecure configuration usable, and the merchant would be worse off for
 * our helpfulness.
 *
 * RATE LIMITS
 * -----------
 * WooCommerce defines none. It is self-hosted, so the real limit is whatever
 * the merchant's hosting imposes -- and a shared-hosting store can be knocked
 * over by an aggressive sync. Being a considerate guest on someone else's
 * server is a correctness requirement here, not politeness: a store we take
 * down stops selling.
 *
 * So: one request at a time, a modest page size, `Retry-After` respected, and
 * 429/503 reported to the engine as a rate limit rather than a failure.
 */

/** The store's own address, plus its credentials. */
export type WooCredentials = {
  consumer_key: string
  consumer_secret: string
}

export type WooRequest = {
  siteUrl: string
  credentials: WooCredentials
  path: string
  query?: Record<string, string | number>
}

export type WooResponse =
  | {
      kind: "ok"
      body: unknown[]
      /** From `X-WP-TotalPages`, when the store sends it. */
      totalPages: number | null
      total: number | null
    }
  | { kind: "rate_limited"; retryAfterMs: number; reason: string }
  | { kind: "retryable_error"; reason: string }
  | { kind: "permanent_error"; reason: string }

const TIMEOUT_MS = 20_000

/* -------------------------------------------------------------------------- */
/* The store URL is user input, and it is used to make a request              */
/* -------------------------------------------------------------------------- */

/**
 * Host names that must never be fetched.
 *
 * A connection form that takes a URL and then fetches it is a
 * server-side request forgery hole unless something stops it. An owner who
 * types `http://169.254.169.254` is probably confused; an attacker who types
 * it is asking our server to read its own cloud credentials and hand them back
 * in an error message.
 *
 * Checked as a literal host rather than by resolving DNS: resolution can
 * change between the check and the request. This blocks the obvious cases; the
 * decisive protection is that BizMind only ever sends a store's own
 * credentials to the host the owner named, and never reflects a response body
 * back to them.
 */
const FORBIDDEN_HOST = new RegExp(
  [
    "^localhost$",
    "^127\\.",
    "^0\\.",
    "^10\\.",
    "^169\\.254\\.", // link-local, including the cloud metadata address
    "^192\\.168\\.",
    "^172\\.(1[6-9]|2[0-9]|3[01])\\.",
    "^\\[?::1\\]?$",
    "^\\[?f[cd][0-9a-f]{2}:", // unique-local IPv6
    "\\.local$",
    "\\.internal$",
  ].join("|"),
  "i"
)

export type SiteUrlCheck =
  | { ok: true; origin: string }
  | { ok: false; reason: string }

/**
 * Validates and normalises a store address.
 *
 * Returns the ORIGIN only. A path, query or fragment the owner pasted is
 * discarded rather than carried into every subsequent request -- pasting the
 * whole address bar is the normal mistake, and `.../wp-admin/edit.php` should
 * not become the API root.
 */
export function checkSiteUrl(raw: string): SiteUrlCheck {
  let url: URL

  try {
    url = new URL(raw.trim())
  } catch {
    return {
      ok: false,
      reason: "That is not a valid web address. It should look like https://yourstore.com",
    }
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason:
        "BizMind only connects to stores served over HTTPS. Over plain HTTP " +
        "your orders and your API keys travel in the clear, where anyone on " +
        "the network can read them.",
    }
  }

  if (FORBIDDEN_HOST.test(url.hostname)) {
    return {
      ok: false,
      reason: "That address points at a private or internal host, so it cannot be reached.",
    }
  }

  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason: "Remove the username and password from the address. Keys go in the fields below.",
    }
  }

  return { ok: true, origin: url.origin }
}

/* -------------------------------------------------------------------------- */
/* The request                                                                */
/* -------------------------------------------------------------------------- */

function authorization(credentials: WooCredentials): string {
  const pair = `${credentials.consumer_key}:${credentials.consumer_secret}`
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after")
  if (!header) return 60_000

  const seconds = Number.parseInt(header, 10)
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 3_600_000)

  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(date - Date.now(), 1_000)

  return 60_000
}

/**
 * One GET against the store's REST API.
 *
 * Never throws for an HTTP status: every outcome the engine must decide about
 * is a variant of the return type. An exception would flatten "wait a minute",
 * "your key was revoked" and "their server fell over" into one thing, and
 * those call for three different decisions.
 */
export async function wooGet(request: WooRequest): Promise<WooResponse> {
  const site = checkSiteUrl(request.siteUrl)
  if (!site.ok) return { kind: "permanent_error", reason: site.reason }

  const url = new URL(`${site.origin}/wp-json/wc/v3/${request.path}`)
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, String(value))
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: authorization(request.credentials),
        Accept: "application/json",
        "User-Agent": "BizMind/1.0",
      },
      // A redirect could carry the Authorization header to a host the owner
      // never named. WooCommerce has no reason to redirect an API call.
      redirect: "manual",
    })

    if (response.status >= 300 && response.status < 400) {
      return {
        kind: "permanent_error",
        reason:
          "The store redirected the API request. Check the address is the exact " +
          "site URL, including www if the store uses it.",
      }
    }

    if (response.status === 401 || response.status === 403) {
      return {
        kind: "permanent_error",
        reason:
          "The store rejected the API key. Check it still exists in " +
          "WooCommerce > Settings > Advanced > REST API and has Read permission.",
      }
    }

    if (response.status === 404) {
      return {
        kind: "permanent_error",
        reason:
          "The store's REST API was not found. WooCommerce 3.5 or later must be " +
          "active and permalinks must not be set to Plain.",
      }
    }

    if (response.status === 429 || response.status === 503) {
      return {
        kind: "rate_limited",
        retryAfterMs: retryAfterMs(response),
        reason: `The store asked us to slow down (${response.status}).`,
      }
    }

    if (response.status >= 500) {
      return { kind: "retryable_error", reason: `The store returned ${response.status}.` }
    }

    if (!response.ok) {
      return { kind: "permanent_error", reason: `The store returned ${response.status}.` }
    }

    const body: unknown = await response.json()

    if (!Array.isArray(body)) {
      return {
        kind: "retryable_error",
        reason: "The store returned something that was not a list of records.",
      }
    }

    const pages = Number.parseInt(response.headers.get("x-wp-totalpages") ?? "", 10)
    const total = Number.parseInt(response.headers.get("x-wp-total") ?? "", 10)

    return {
      kind: "ok",
      body,
      totalPages: Number.isFinite(pages) ? pages : null,
      total: Number.isFinite(total) ? total : null,
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "retryable_error", reason: "The store did not respond in time." }
    }

    // A DNS failure, a refused connection, a bad certificate. All worth
    // another attempt: the engine decides how many.
    return { kind: "retryable_error", reason: "The store could not be reached." }
  } finally {
    clearTimeout(timer)
  }
}
