import "server-only"

import { decryptCredential } from "@/lib/crypto"
import { getConnector, isKnownProvider } from "@/services/integrations/contract"
import { callTrusted } from "@/services/integrations/security/privileged"

/**
 * Receiving a webhook.
 *
 * THE ORDER OF THESE STEPS IS THE SECURITY MODEL.
 *
 *   1. read the RAW body                 bytes, untouched
 *   2. identify the provider             from the path, against a registry
 *   3. identify the store                from headers -- still untrusted
 *   4. resolve the connection            the ONLY source of the tenant
 *   5. verify the signature              constant time, over the raw body
 *   6. persist                           unique key decides duplicates
 *   7. return quickly                    processing happens later
 *
 * Nothing before step 4 is trusted, and nothing after step 5 happens if
 * verification failed. The tenant is never read from the request: a body that
 * says `business_id` is a body that is ignored.
 *
 * WHY IT RETURNS BEFORE PROCESSING
 * --------------------------------
 * Shopify allows five seconds in total and deletes the subscription after
 * eight consecutive failures. Normalising and writing inline would eventually
 * exceed that on a busy store, and the punishment is silent: no error, no
 * alert, just a store that stops updating. So this path verifies, stores, and
 * gets out of the way.
 */

export type ReceiveOutcome =
  /** Stored. Will be processed by the worker. */
  | { kind: "accepted"; eventId: string; status: number }
  /** A redelivery. Already stored, deliberately does nothing. */
  | { kind: "duplicate"; eventId: string; status: number }
  /** Signature did not verify. Recorded, then refused. */
  | { kind: "rejected"; reason: string; status: number }
  /** Provider unknown, store unknown, or headers unusable. Nothing written. */
  | { kind: "ignored"; reason: string; status: number }

type LookupRow = {
  account_id: string
  resolved_business_id: string
  webhook_secret_encrypted: string | null
  account_status: string
}

type IngestRow = {
  outcome: "ACCEPTED" | "DUPLICATE" | "REJECTED" | "UNKNOWN_ACCOUNT"
  event_id: string | null
  business_id: string | null
}

export async function receiveWebhook(input: {
  provider: string
  headers: Record<string, string>
  /** The exact bytes as text. Never a re-serialised object. */
  rawBody: string
}): Promise<ReceiveOutcome> {
  const { provider, headers, rawBody } = input

  /* 2. An unknown provider is refused before anything else happens. ------- */
  if (!isKnownProvider(provider)) {
    return { kind: "ignored", reason: "Unknown provider.", status: 404 }
  }

  const connector = getConnector(provider)
  if (!connector) {
    return { kind: "ignored", reason: "Provider is not enabled.", status: 404 }
  }

  /* 3. Who does the provider SAY this is? Untrusted until step 4. --------- */
  const parsed = connector.parseWebhook({ headers, rawBody })
  if (parsed.kind === "unparseable") {
    return { kind: "ignored", reason: parsed.reason, status: 400 }
  }

  const { externalAccountId, externalEventId, eventType } = parsed.identity

  /* 4. TRUSTED BUSINESS RESOLUTION. ---------------------------------------
   * The connection row is the only thing that decides whose data this is. An
   * unknown store resolves to nothing and nothing is written -- which is also
   * what bounds the cost of a forged flood: an attacker must already know a
   * real store's identity before they can cause a single row to exist.
   */
  const rows = await callTrusted<LookupRow[]>("webhook_account_lookup", {
    p_provider: provider,
    p_external_account_id: externalAccountId,
  })

  const account = rows?.[0]
  if (!account) {
    // Deliberately vague, and deliberately not 404: telling a caller which
    // store identities exist is telling them which ones to forge against.
    return { kind: "ignored", reason: "No connected account for this delivery.", status: 202 }
  }

  if (!account.webhook_secret_encrypted) {
    return {
      kind: "ignored",
      reason: "That connection has no webhook secret configured.",
      status: 202,
    }
  }

  /* 5. Verify, over the raw body, in constant time. ----------------------- */
  let signatureValid = false
  try {
    const secret = decryptCredential(account.webhook_secret_encrypted, {
      businessId: account.resolved_business_id,
      purpose: "webhook_secret",
    })

    signatureValid = connector.verifyWebhook({ headers, rawBody, secret })
  } catch {
    // A secret we cannot decrypt is an operational failure, not a valid
    // delivery. Treated as unverified rather than trusted.
    signatureValid = false
  }

  /* 6. Persist. The unique key -- not an existence check -- decides. ------ */
  const ingested = await callTrusted<IngestRow[]>("webhook_event_ingest", {
    p_provider: provider,
    p_external_account_id: externalAccountId,
    p_external_event_id: externalEventId,
    p_event_type: eventType,
    p_raw_body: rawBody,
    p_signature_valid: signatureValid,
  })

  const result = ingested?.[0]

  if (!result || result.outcome === "UNKNOWN_ACCOUNT") {
    return { kind: "ignored", reason: "No connected account for this delivery.", status: 202 }
  }

  if (result.outcome === "DUPLICATE") {
    // 200, not an error. Providers retry by design, and punishing a retry
    // with a non-2xx is how a healthy integration gets itself disabled.
    return { kind: "duplicate", eventId: result.event_id ?? "", status: 200 }
  }

  if (result.outcome === "REJECTED") {
    return { kind: "rejected", reason: "Signature verification failed.", status: 401 }
  }

  return { kind: "accepted", eventId: result.event_id ?? "", status: 200 }
}
