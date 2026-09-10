import "server-only"

import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/types/database"

/**
 * The ONLY place in BizMind that uses the Supabase service-role key.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Every other query in this product runs as the signed-in user, under Row
 * Level Security. A webhook has no signed-in user: the provider calls us
 * directly, and the tenant is not knowable until we have looked up which
 * connection the delivery belongs to. The same is true of the sync worker,
 * which runs on a schedule with nobody watching.
 *
 * CLAUDE.md forbids the service-role key for serving a USER request, and that
 * rule is not bent here. A verified vendor callback and a scheduled worker are
 * background jobs, which is the case that rule explicitly allows.
 *
 * WHY IT IS ONE FILE
 * ------------------
 * The key bypasses RLS completely. A module that hands out a general-purpose
 * privileged client turns every future mistake into a cross-tenant one, so
 * this module deliberately does not export the client.
 *
 * It exports `callTrusted()`, which can only invoke the small set of
 * SECURITY DEFINER functions in migration 0012. Every one of those resolves
 * the tenant itself from a connection row and takes no business_id argument,
 * so there is no parameter an attacker could point at another tenant even with
 * the ability to call them.
 *
 * `scripts/verify-integration-security.mts` asserts that this is the only file
 * in `src/` referencing the service-role key, the same way the OpenAI key is
 * confined to `src/services/ai/client.ts`.
 */

/**
 * The functions this door opens onto. Nothing else is reachable.
 *
 * Adding a name here is a security decision, not a convenience: it must be a
 * function that derives its own tenant.
 */
const TRUSTED_FUNCTIONS = [
  "webhook_account_lookup",
  "webhook_event_ingest",
  "webhook_claim_events",
  "webhook_event_complete",
  "webhook_apply_records",
  "sync_claim_jobs",
  "sync_job_context",
  "sync_apply_orders",
  "sync_run_start",
  "sync_job_complete",
] as const

export type TrustedFunction = (typeof TRUSTED_FUNCTIONS)[number]

export class PrivilegedAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PrivilegedAccessError"
  }
}

let cached: SupabaseClient<Database> | null = null

/** Not exported. The client never leaves this module. */
function privilegedClient(): SupabaseClient<Database> {
  if (cached) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url) {
    throw new PrivilegedAccessError("Supabase is not configured.")
  }

  if (!serviceKey) {
    throw new PrivilegedAccessError(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Webhook delivery and background " +
        "sync cannot run without it. It must never be exposed to the browser."
    )
  }

  cached = createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-BizMind-Context": "integration-worker" } },
  })

  return cached
}

/** Whether the privileged path is configured. Never throws, never reveals. */
export function isPrivilegedAccessConfigured(): boolean {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().length ?? 0) > 20
}

/**
 * Calls one of the trusted, tenant-resolving database functions.
 *
 * The allowlist is enforced at runtime as well as in the type, because a type
 * is erased and this is the one place where being wrong is expensive.
 */
export async function callTrusted<T>(
  fn: TrustedFunction,
  args: Record<string, unknown>
): Promise<T> {
  if (!TRUSTED_FUNCTIONS.includes(fn)) {
    throw new PrivilegedAccessError(
      `"${fn}" is not a trusted integration function. The privileged path is ` +
        "restricted to functions that resolve their own tenant."
    )
  }

  // A business_id argument would defeat the entire design: these functions
  // derive the tenant from a connection row precisely so that no caller can
  // choose one.
  if ("p_business_id" in args || "business_id" in args) {
    throw new PrivilegedAccessError(
      "A trusted integration call must not carry a business id. The tenant is " +
        "resolved from the connection, never supplied by the caller."
    )
  }

  const { data, error } = await privilegedClient().rpc(
    fn as never,
    args as never
  )

  if (error) {
    // The database's own wording can name constraints and columns. Logged for
    // an operator; not returned to a caller that might surface it.
    console.error(`[integration] ${fn} failed: ${error.message}`)
    throw new PrivilegedAccessError(`The ${fn} operation could not be completed.`)
  }

  return data as T
}
