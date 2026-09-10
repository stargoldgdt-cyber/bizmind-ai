import "server-only"

import { createClient } from "@/lib/supabase/server"
import type {
  IntegrationAccount,
  IntegrationProvider,
  SyncJob,
  WebhookEventStatus,
} from "@/types/database"

/**
 * Integration status, for a person.
 *
 * Service-level functions first, as the brief asks. What an owner needs to
 * know is short: is it connected, when did it last work, and is anything
 * wrong. A failing sync that nobody is told about is worse than no sync,
 * because the figures keep looking complete.
 *
 * Every query here runs as the signed-in user, under RLS. There is no
 * business id parameter: the rows a caller can see are the rows they are
 * entitled to see, decided by the database.
 */

export type ConnectionStatus = {
  accountId: string
  provider: IntegrationProvider
  externalAccountId: string
  displayName: string | null
  status: IntegrationAccount["status"]
  lastSuccessfulSyncAt: string | null
  lastAttemptedSyncAt: string | null
  lastError: string | null
  jobs: {
    resource: SyncJob["resource"]
    status: SyncJob["status"]
    mode: SyncJob["mode"]
    attempts: number
    nextRunAt: string
    lastError: string | null
  }[]
}

export async function listConnections(): Promise<ConnectionStatus[]> {
  const supabase = await createClient()

  // Two plain queries rather than an embedded join. The join would need
  // reverse-relationship metadata in the generated types, and reading two
  // RLS-scoped tables is both clearer and no slower at this size.
  const [accounts, integrations, jobs] = await Promise.all([
    supabase
      .from("integration_accounts")
      // A single literal, not a concatenation: supabase-js infers the row
      // shape from the string itself, and a joined expression infers nothing.
      .select(
        "id, integration_id, external_account_id, display_name, status, last_successful_sync_at, last_attempted_sync_at, last_error"
      )
      .order("connected_at", { ascending: false }),
    supabase.from("integrations").select("id, provider"),
    supabase
      .from("sync_jobs")
      .select(
        "integration_account_id, resource, status, mode, attempts, next_run_at, last_error"
      ),
  ])

  if (accounts.error || !accounts.data) return []

  const providerOf = new Map(
    (integrations.data ?? []).map((row) => [row.id, row.provider])
  )

  const jobsByAccount = new Map<string, ConnectionStatus["jobs"]>()
  for (const job of jobs.data ?? []) {
    const list = jobsByAccount.get(job.integration_account_id) ?? []
    list.push({
      resource: job.resource,
      status: job.status,
      mode: job.mode,
      attempts: job.attempts,
      nextRunAt: job.next_run_at,
      lastError: job.last_error,
    })
    jobsByAccount.set(job.integration_account_id, list)
  }

  return accounts.data.map((row) => ({
    accountId: row.id,
    provider: providerOf.get(row.integration_id) ?? "FIXTURE",
    externalAccountId: row.external_account_id,
    displayName: row.display_name,
    status: row.status,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    lastAttemptedSyncAt: row.last_attempted_sync_at,
    lastError: row.last_error,
    jobs: jobsByAccount.get(row.id) ?? [],
  }))
}

export type WebhookHealth = {
  total: number
  byStatus: Partial<Record<WebhookEventStatus, number>>
  lastReceivedAt: string | null
}

/**
 * Webhook health.
 *
 * `DUPLICATE` is reported as its own figure rather than hidden. A steady trickle
 * of duplicates is a provider retrying normally; a sudden flood is somebody
 * replaying captured traffic, and that difference is only visible if the
 * ordinary case is on screen too.
 */
export async function webhookHealth(): Promise<WebhookHealth> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("webhook_events")
    .select("status, received_at")
    .order("received_at", { ascending: false })
    .limit(500)

  if (error || !data) return { total: 0, byStatus: {}, lastReceivedAt: null }

  const byStatus: Partial<Record<WebhookEventStatus, number>> = {}
  for (const row of data) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
  }

  return {
    total: data.length,
    byStatus,
    lastReceivedAt: data[0]?.received_at ?? null,
  }
}

/** Recent deliveries, for the small table on the integrations page. */
export async function recentWebhookEvents(limit = 20) {
  const supabase = await createClient()

  const { data } = await supabase
    .from("webhook_events")
    .select("id, provider, event_type, status, signature_valid, received_at, last_error")
    .order("received_at", { ascending: false })
    .limit(limit)

  return data ?? []
}
