"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { encryptCredential, isEncryptionConfigured } from "@/lib/crypto"
import { createClient } from "@/lib/supabase/server"
import { getActiveBusiness } from "@/features/businesses/queries"
import { getConnector, isKnownProvider } from "@/services/integrations"

/**
 * Connecting and managing integrations.
 *
 * THE BUSINESS ALWAYS COMES FROM THE SESSION.
 *
 * Not from the form, not from a hidden field, not from a query parameter.
 * Every function below resolves it with `getActiveBusiness()`, which checks
 * real membership, and the database functions these call re-check the caller's
 * role rather than trusting that this layer did.
 *
 * Credentials never round-trip through the browser. They arrive once, are
 * encrypted here on the server, and are never read back: migration 0012
 * revokes SELECT on those columns from `authenticated`, so even a deliberate
 * attempt to fetch them returns nothing.
 */

const PROVIDERS = ["FIXTURE", "WOOCOMMERCE", "SHOPIFY"] as const

const connectSchema = z.object({
  provider: z.enum(PROVIDERS),
  /** The provider's stable identity: a shop domain, a site URL. */
  externalAccountId: z.string().min(1).max(300),
  displayName: z.string().max(200).optional(),
  /** Provider-specific. Encrypted before storage, never returned. */
  credentials: z.record(z.string(), z.string()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export type ConnectResult =
  | { ok: true; accountId: string; displayName: string }
  | { ok: false; error: string }

export async function connectIntegrationAction(
  rawInput: unknown
): Promise<ConnectResult> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  const parsed = connectSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "Those connection details are not valid." }

  const { provider, externalAccountId, displayName, credentials, metadata } = parsed.data

  if (!isKnownProvider(provider)) {
    return { ok: false, error: "That provider is not supported." }
  }

  const connector = getConnector(provider)
  if (!connector) return { ok: false, error: "That provider is not enabled." }

  if (!isEncryptionConfigured()) {
    return {
      ok: false,
      error:
        "Credential encryption is not configured, so a connection cannot be stored safely. " +
        "Set BIZMIND_ENCRYPTION_KEY and restart.",
    }
  }

  // Check the credentials work BEFORE storing them, so a wrong key is found
  // while the owner is looking at the form rather than three days later when
  // a figure is missing.
  const validation = await connector.validateConnection({
    externalAccountId,
    credentials,
    metadata,
  })

  if (!validation.ok) {
    return { ok: false, error: validation.reason }
  }

  const supabase = await createClient()

  const { data: account, error } = await supabase.rpc("integration_account_connect", {
    p_business_id: business.id,
    p_provider: provider,
    p_external_account_id: externalAccountId,
    p_display_name: displayName ?? validation.displayName,
    p_channel_type: connector.channelType as never,
    p_metadata: validation.metadata as never,
  })

  if (error || !account) {
    const permission = error?.message.includes("owner or admin") ?? false
    return {
      ok: false,
      error: permission
        ? "Only an owner or admin can connect an integration."
        : "That connection could not be saved.",
    }
  }

  // Secrets are written in a second step, through the privileged path, so the
  // ciphertext never passes through a function `authenticated` can call.
  const sealedCredentials = encryptCredential(JSON.stringify(credentials), {
    businessId: business.id,
    purpose: "api_credentials",
  })

  const webhookSecret = crypto.randomUUID().replace(/-/g, "")
  const sealedWebhookSecret = encryptCredential(webhookSecret, {
    businessId: business.id,
    purpose: "webhook_secret",
  })

  const stored = await storeSecrets(account.id, sealedCredentials, sealedWebhookSecret)
  if (!stored) {
    return { ok: false, error: "The connection was created but its credentials could not be stored." }
  }

  revalidatePath("/integrations")
  return { ok: true, accountId: account.id, displayName: account.display_name ?? externalAccountId }
}

/**
 * Writes the sealed secrets.
 *
 * Isolated in its own function so the import of the privileged module is in
 * one obvious place, and so the security scanner can assert that this file
 * never reads a secret back.
 */
async function storeSecrets(
  accountId: string,
  credentials: string,
  webhookSecret: string
): Promise<boolean> {
  const { storeAccountSecrets } = await import(
    "@/services/integrations/security/store-secrets"
  )
  return storeAccountSecrets(accountId, credentials, webhookSecret)
}

const accountSchema = z.object({ accountId: z.string().uuid() })

export type ActionResult = { ok: true } | { ok: false; error: string }

export async function disconnectIntegrationAction(
  rawInput: unknown
): Promise<ActionResult> {
  const parsed = accountSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That request could not be read." }

  const supabase = await createClient()

  // No business id is passed. RLS decides whether this row is visible at all,
  // so an account id belonging to another business simply is not found.
  const { error } = await supabase.rpc("integration_account_revoke", {
    p_account_id: parsed.data.accountId,
  })

  if (error) {
    return {
      ok: false,
      error: error.message.includes("owner or admin")
        ? "Only an owner or admin can disconnect an integration."
        : "That connection could not be disconnected.",
    }
  }

  revalidatePath("/integrations")
  return { ok: true }
}

const syncSchema = accountSchema.extend({
  resource: z.enum(["ORDERS", "PRODUCTS", "CUSTOMERS", "INVENTORY"]),
  mode: z.enum(["INITIAL", "INCREMENTAL"]).default("INCREMENTAL"),
})

export async function startSyncAction(rawInput: unknown): Promise<ActionResult> {
  const parsed = syncSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That request could not be read." }

  const supabase = await createClient()

  const { error } = await supabase.rpc("sync_enqueue", {
    p_account_id: parsed.data.accountId,
    p_resource: parsed.data.resource,
    p_mode: parsed.data.mode,
  })

  if (error) {
    return {
      ok: false,
      error: error.message.includes("owner or admin")
        ? "Only an owner or admin can start a sync."
        : "That sync could not be started.",
    }
  }

  revalidatePath("/integrations")
  return { ok: true }
}

const replaySchema = z.object({ eventId: z.string().uuid() })

export async function replayWebhookAction(rawInput: unknown): Promise<ActionResult> {
  const parsed = replaySchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That request could not be read." }

  const supabase = await createClient()

  const { error } = await supabase.rpc("webhook_event_replay", {
    p_event_id: parsed.data.eventId,
  })

  if (error) {
    return {
      ok: false,
      error: error.message.includes("owner or admin")
        ? "Only an owner or admin can replay a webhook."
        : "That delivery could not be replayed.",
    }
  }

  revalidatePath("/integrations")
  return { ok: true }
}
