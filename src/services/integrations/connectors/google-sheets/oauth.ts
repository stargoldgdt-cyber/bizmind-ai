import "server-only"

/**
 * Google OAuth for BizMind -- the only file that reads the client secret.
 *
 * THE FLOW
 * --------
 *   Connect Google -> consent URL built here -> Google consent screen
 *   -> Google redirects back with a CODE -> exchangeCode() swaps it for tokens
 *      server-side, with the client secret -> the refresh token is sealed and
 *      stored; nothing is returned to the browser
 *
 * `access_type=offline` asks Google for a refresh token, so sync keeps working
 * while nobody is signed in. `prompt=consent` matters more than it looks:
 * Google returns a refresh token ONLY on the first authorisation, so without it
 * a reconnect silently yields none and the connection dies within the hour.
 *
 * ONE SCOPE: drive.file
 * ---------------------
 * Access only to files the user explicitly picks for BizMind. Google classes it
 * non-sensitive and recommends it. `include_granted_scopes` is deliberately NOT
 * sent: it would fold in any other scope ever granted to this client, and the
 * point is to hold exactly one.
 *
 * `scripts/verify-google-sheets.mts` fails the build if the client secret's
 * name appears in any other file under src/.
 */

export const GOOGLE_SCOPE_DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke"
const TIMEOUT_MS = 15_000

/** A refreshed token is treated as expired this long before Google says so. */
const EXPIRY_MARGIN_MS = 60_000

/** `fetch`, injectable so tests never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type GoogleOAuthConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/** The server's Google client configuration, or null when it is not set up. */
export function googleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim()

  if (!clientId || !clientSecret || !redirectUri) return null
  return { clientId, clientSecret, redirectUri }
}

/**
 * The client id alone. The browser's Google sign-in and Picker need it, and an
 * OAuth client id is public by design -- it appears in every consent URL.
 */
export function googleClientId(): string | null {
  return process.env.GOOGLE_CLIENT_ID?.trim() || null
}

export function buildConsentUrl(config: GoogleOAuthConfig, state: string): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set("client_id", config.clientId)
  url.searchParams.set("redirect_uri", config.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", GOOGLE_SCOPE_DRIVE_FILE)
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  url.searchParams.set("state", state)
  return url.toString()
}

/* -------------------------------------------------------------------------- */

export type TokenExchange =
  | {
      ok: true
      refreshToken: string
      accessToken: string
      expiresInSeconds: number
      grantedScopes: string[]
    }
  | {
      ok: false
      reason: "missing_refresh_token" | "scope_not_granted" | "rejected" | "unavailable"
      /** Written for the owner. Never contains a token. */
      message: string
    }

/** Swaps an authorisation code for tokens. Server-side only, with the secret. */
export async function exchangeCode(
  code: string,
  config: GoogleOAuthConfig,
  fetchImpl: FetchLike = fetch
): Promise<TokenExchange> {
  const response = await postForm(fetchImpl, TOKEN_ENDPOINT, {
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  })

  if (response === null) {
    return {
      ok: false,
      reason: "unavailable",
      message: "Google could not be reached. Try connecting again in a moment.",
    }
  }

  const body = await readJson(response)

  if (!response.ok) {
    return {
      ok: false,
      reason: "rejected",
      message: "Google did not accept that sign-in. Please try connecting again.",
    }
  }

  const granted = text(body.scope)?.split(" ").filter(Boolean) ?? []

  // With granular consent a person can untick a permission. Without drive.file
  // BizMind cannot open the sheet they are about to choose.
  if (!granted.includes(GOOGLE_SCOPE_DRIVE_FILE)) {
    return {
      ok: false,
      reason: "scope_not_granted",
      message:
        "BizMind needs permission to open the spreadsheets you choose. Please " +
        "connect again and allow it.",
    }
  }

  const refreshToken = text(body.refresh_token)
  const accessToken = text(body.access_token)

  if (!refreshToken) {
    return {
      ok: false,
      reason: "missing_refresh_token",
      message:
        "Google did not grant lasting access, so BizMind could not keep your " +
        "sheet in sync. Please connect again.",
    }
  }

  if (!accessToken) {
    return {
      ok: false,
      reason: "rejected",
      message: "Google did not accept that sign-in. Please try connecting again.",
    }
  }

  return {
    ok: true,
    refreshToken,
    accessToken,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 3600,
    grantedScopes: granted,
  }
}

export type AccessTokenResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | {
      ok: false
      /**
       * reauth        the owner must reconnect Google (revoked, expired, or a
       *               Testing-mode token past its 7 days)
       * misconfigured the server's client id or secret is wrong -- not the
       *               owner's problem to fix
       * retryable     Google is unavailable; try later
       */
      kind: "reauth" | "misconfigured" | "retryable"
      message: string
    }

/** Mints a short-lived access token from a stored refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
  config: GoogleOAuthConfig,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now
): Promise<AccessTokenResult> {
  const response = await postForm(fetchImpl, TOKEN_ENDPOINT, {
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  })

  if (response === null) {
    return { ok: false, kind: "retryable", message: "Google could not be reached." }
  }

  const body = await readJson(response)

  if (response.ok) {
    const accessToken = text(body.access_token)
    if (!accessToken) {
      return { ok: false, kind: "retryable", message: "Google returned no access token." }
    }

    const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600
    return {
      ok: true,
      accessToken,
      expiresAt: now() + seconds * 1000 - EXPIRY_MARGIN_MS,
    }
  }

  const error = text(body.error)

  if (error === "invalid_grant") {
    return {
      ok: false,
      kind: "reauth",
      message: "Google access has expired or was revoked. Reconnect Google to resume syncing.",
    }
  }

  if (error === "invalid_client" || error === "unauthorized_client") {
    return {
      ok: false,
      kind: "misconfigured",
      message: "This server's Google client is not set up correctly.",
    }
  }

  return { ok: false, kind: "retryable", message: `Google returned ${response.status}.` }
}

/**
 * Tells Google to forget a token. Best effort: a disconnect must succeed on
 * BizMind's side even when Google cannot be reached.
 */
export async function revokeGoogleToken(
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<boolean> {
  const response = await postForm(fetchImpl, REVOKE_ENDPOINT, { token })
  return response !== null && response.ok
}

/* -------------------------------------------------------------------------- */

/**
 * POSTs a form. Secrets travel in the BODY, never the query string, where they
 * would be written into every access log between here and Google.
 */
async function postForm(
  fetchImpl: FetchLike,
  url: string,
  fields: Record<string, string>
): Promise<Response | null> {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return null
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json()
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}
