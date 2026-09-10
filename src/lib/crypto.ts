import "server-only"

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

/**
 * Credential encryption.
 *
 * Integration credentials -- an OAuth token, a WooCommerce consumer secret, a
 * webhook signing secret -- are bearer credentials for somebody else's store.
 * A database backup that leaks should not hand an attacker the ability to read
 * a merchant's orders, so they are encrypted before they are stored and the
 * key lives in the environment rather than in the database.
 *
 * AES-256-GCM: standard authenticated encryption from Node's own `crypto`.
 * Nothing here is invented. GCM is chosen over CBC because it authenticates
 * as well as encrypts -- a tampered ciphertext fails to decrypt rather than
 * decrypting to something attacker-influenced.
 *
 * ADDITIONAL AUTHENTICATED DATA
 * -----------------------------
 * Every ciphertext is bound to a context string. Without it, a row's encrypted
 * token could be copied into another row and would still decrypt: the attack
 * is not "read the secret" but "move a valid secret somewhere it authorises
 * something else". The context includes the business id, so a ciphertext
 * carried across tenants fails authentication.
 *
 * FORMAT
 * ------
 *     v1.<iv>.<authTag>.<ciphertext>          (each base64url)
 *
 * The version prefix exists so the scheme can be rotated without guessing at
 * what an old value was.
 */

const VERSION = "v1"
const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12 // GCM's standard nonce length
const KEY_BYTES = 32

/** Thrown for every failure. The message never contains key or plaintext. */
export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialCryptoError"
  }
}

/**
 * The key, read at the moment of use.
 *
 * Not exported, not cached in a module-level constant, and never logged. Read
 * lazily so importing this module in a context without the key configured is
 * harmless -- the failure happens when someone actually tries to use it, with
 * a message that says what to do.
 */
function key(): Buffer {
  const raw = process.env.BIZMIND_ENCRYPTION_KEY?.trim()

  if (!raw) {
    throw new CredentialCryptoError(
      "BIZMIND_ENCRYPTION_KEY is not set. Integration credentials cannot be " +
        "stored or read without it. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    )
  }

  let decoded: Buffer
  try {
    decoded = Buffer.from(raw, "base64")
  } catch {
    throw new CredentialCryptoError("BIZMIND_ENCRYPTION_KEY is not valid base64.")
  }

  if (decoded.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `BIZMIND_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${decoded.length}. ` +
        "It should be 32 random bytes, base64 encoded."
    )
  }

  return decoded
}

/** Whether encryption is configured. Never throws, never reveals the value. */
export function isEncryptionConfigured(): boolean {
  try {
    key()
    return true
  } catch {
    return false
  }
}

/**
 * The context a ciphertext is bound to.
 *
 * `businessId` is what makes a ciphertext untransferable between tenants.
 * `purpose` keeps a webhook secret from being decrypted as though it were an
 * access token, which matters if a future bug reads the wrong column.
 */
export type CredentialContext = {
  businessId: string
  purpose: "access_token" | "api_credentials" | "webhook_secret"
}

function additionalData(context: CredentialContext): Buffer {
  return Buffer.from(`bizmind:${context.purpose}:${context.businessId}`, "utf8")
}

/** Encrypts a secret. The result is safe to store; it is not safe to display. */
export function encryptCredential(
  plaintext: string,
  context: CredentialContext
): string {
  if (plaintext === "") {
    throw new CredentialCryptoError("Refusing to encrypt an empty credential.")
  }

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  cipher.setAAD(additionalData(context))

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")
}

/**
 * Decrypts a stored credential.
 *
 * Throws if the ciphertext was tampered with, or if the context does not match
 * the one it was sealed with. Both are the same failure as far as a caller is
 * concerned: this value is not usable here.
 */
export function decryptCredential(
  payload: string,
  context: CredentialContext
): string {
  const parts = payload.split(".")

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CredentialCryptoError("Stored credential is not in a recognised format.")
  }

  const [, ivPart, tagPart, dataPart] = parts

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key(),
      Buffer.from(ivPart, "base64url")
    )
    decipher.setAAD(additionalData(context))
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"))

    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    // Deliberately opaque. Distinguishing "wrong key" from "tampered" from
    // "wrong tenant" would tell an attacker which of those they achieved.
    throw new CredentialCryptoError(
      "Stored credential could not be decrypted. It may have been tampered " +
        "with, sealed for a different business, or encrypted with a different key."
    )
  }
}

/**
 * Constant-time comparison of two signatures.
 *
 * `a === b` on strings short-circuits at the first differing byte, and the
 * time that takes is measurable over a network. An attacker who can measure it
 * can recover a signature one byte at a time, which turns "you need the
 * secret" into "you need patience".
 *
 * Length is compared first and non-constant-time, which leaks only the length
 * of a value whose length is already fixed by the algorithm.
 */
export function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(provided, "utf8")

  if (a.length !== b.length) return false

  return timingSafeEqual(a, b)
}
