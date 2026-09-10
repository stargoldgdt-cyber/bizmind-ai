import "server-only"

import { createClient } from "@supabase/supabase-js"

import type { Database } from "@/types/database"

/**
 * Writing sealed credentials.
 *
 * Migration 0012 revokes INSERT and UPDATE on the credential columns from
 * `authenticated`, so a signed-in user cannot write them even with a valid
 * session -- which also means the ordinary server-side client cannot. That is
 * deliberate: a credential column that ordinary application code can write is
 * a credential column ordinary application code can be tricked into writing.
 *
 * This module does one thing, on one table, on two columns. It never reads
 * them back, and it never returns them.
 *
 * It shares the service-role key with `privileged.ts`; the security scanner
 * treats both as the confined set and fails if the key appears anywhere else.
 */

let cached: ReturnType<typeof createClient<Database>> | null = null

function client() {
  if (cached) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url || !key) {
    throw new Error("The privileged Supabase client is not configured.")
  }

  cached = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return cached
}

/**
 * Stores the sealed credentials for a connection.
 *
 * Both values are already AES-256-GCM ciphertext bound to this business; this
 * function does not encrypt and does not decrypt. Returns a boolean rather
 * than throwing, because the caller's job is to tell an owner whether their
 * connection saved, not to surface a database error.
 */
export async function storeAccountSecrets(
  accountId: string,
  credentialsEncrypted: string,
  webhookSecretEncrypted: string
): Promise<boolean> {
  try {
    const { error } = await client()
      .from("integration_accounts")
      .update({
        credentials_encrypted: credentialsEncrypted,
        webhook_secret_encrypted: webhookSecretEncrypted,
      })
      .eq("id", accountId)

    if (error) {
      // Never log the values. The message alone is enough to act on.
      console.error(`[integration] storing credentials failed: ${error.message}`)
      return false
    }

    return true
  } catch (error) {
    console.error("[integration] storing credentials failed", error)
    return false
  }
}
