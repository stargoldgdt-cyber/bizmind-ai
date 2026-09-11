import "server-only"

import { randomBytes } from "node:crypto"

import { decryptCredential, encryptCredential } from "@/lib/crypto"

/**
 * The Google sign-in handshake.
 *
 * `state` is how the callback knows the response belongs to a sign-in THIS
 * browser started, rather than one an attacker started and tricked the owner
 * into finishing -- the cross-site request forgery Google's documentation
 * tells every OAuth client to prevent.
 *
 * The random value goes to Google in `state`. A sealed copy goes into an
 * httpOnly cookie, bound to the signed-in user and the active business, and
 * expiring after ten minutes. The callback accepts the response only when:
 *
 *   - the cookie opens for THIS business (the AES-GCM additional data carries
 *     the business id, so switching business mid-flow fails to decrypt),
 *   - it was sealed for THIS user,
 *   - it has not expired, and
 *   - the value Google echoed matches it, compared in constant time.
 */

export const OAUTH_STATE_COOKIE = "bizmind_google_oauth"

/** The cookie is only ever sent to the two Google OAuth routes. */
export const OAUTH_STATE_COOKIE_PATH = "/api/v1/integrations/google"

const LIFETIME_MS = 10 * 60 * 1000

export const OAUTH_STATE_MAX_AGE_SECONDS = LIFETIME_MS / 1000

export function newOAuthState(): string {
  return randomBytes(32).toString("base64url")
}

export function sealOAuthState(input: {
  nonce: string
  userId: string
  businessId: string
  now?: number
}): string {
  return encryptCredential(
    JSON.stringify({
      n: input.nonce,
      u: input.userId,
      e: (input.now ?? Date.now()) + LIFETIME_MS,
    }),
    { businessId: input.businessId, purpose: "oauth_state" }
  )
}

/**
 * The nonce inside a sealed state, or null if it is not valid for this user
 * and business right now. Every failure looks the same to the caller.
 */
export function openOAuthState(
  sealed: string,
  expected: { userId: string; businessId: string; now?: number }
): string | null {
  try {
    const parsed: unknown = JSON.parse(
      decryptCredential(sealed, { businessId: expected.businessId, purpose: "oauth_state" })
    )

    if (parsed === null || typeof parsed !== "object") return null
    const { n, u, e } = parsed as { n?: unknown; u?: unknown; e?: unknown }

    if (typeof n !== "string" || n === "") return null
    if (u !== expected.userId) return null
    if (typeof e !== "number" || e < (expected.now ?? Date.now())) return null

    return n
  } catch {
    return null
  }
}
