import "server-only"

import { decryptCredential } from "@/lib/crypto"
import type { RawRecord } from "@/services/ingestion/contracts"
import {
  getConnector,
  type ConnectorCredentials,
  type SyncMode,
  type SyncResource,
} from "@/services/integrations/contract"
import { callTrusted } from "@/services/integrations/security/privileged"

/**
 * The sync worker.
 *
 * Claims jobs, runs one page each, records what happened, and decides what
 * happens next. It knows nothing about any provider: every provider-specific
 * decision arrives as a `FetchResult` variant, and the worker's job is to
 * choose a consequence for each.
 *
 * ONE PAGE PER CLAIM, ON PURPOSE
 * ------------------------------
 * A run fetches a single page and returns. A serverless function has a
 * wall-clock limit, and a worker that must finish a whole store or lose its
 * progress is a worker that never finishes a large store. Because the cursor
 * is durable and written only after a page is applied, being cut off mid-sync
 * costs one page, not one sync.
 *
 * WHY THE CURSOR IS WRITTEN LAST
 * ------------------------------
 * Advancing it before the records are durably applied would skip data on a
 * crash -- silently, with nothing to notice. The order here is: fetch, apply,
 * then checkpoint.
 */

const LEASE_SECONDS = 300

export type WorkerResult = {
  claimed: number
  succeeded: number
  retried: number
  rateLimited: number
  deadLettered: number
  failed: number
}

type JobRow = {
  id: string
  business_id: string
  integration_account_id: string
  resource: string
  mode: string
  cursor: string | null
  attempts: number
  max_attempts: number
}

type ContextRow = {
  job_id: string
  resolved_business_id: string
  account_id: string
  provider: string
  external_account_id: string
  credentials_encrypted: string | null
  metadata: Record<string, unknown> | null
  resource: string
  mode: string
  cursor_value: string | null
  account_status: string
}

type RunRow = { id: string }

type ApplyResult = {
  orders_created?: number
  orders_updated?: number
  items_written?: number
  products_created?: number
  products_updated?: number
}

/**
 * Runs one batch of work.
 *
 * Returns counts rather than throwing: a scheduled worker that throws loses
 * the information about the jobs that did succeed.
 */
export async function runSyncWorker(options: {
  workerId: string
  limit?: number
}): Promise<WorkerResult> {
  const result: WorkerResult = {
    claimed: 0,
    succeeded: 0,
    retried: 0,
    rateLimited: 0,
    deadLettered: 0,
    failed: 0,
  }

  const jobs = await callTrusted<JobRow[]>("sync_claim_jobs", {
    p_worker_id: options.workerId,
    p_limit: options.limit ?? 5,
    p_lease_seconds: LEASE_SECONDS,
  })

  if (!jobs || jobs.length === 0) return result
  result.claimed = jobs.length

  for (const job of jobs) {
    const outcome = await runOneJob(job)

    if (outcome === "SUCCEEDED" || outcome === "PARTIAL") result.succeeded += 1
    else if (outcome === "RATE_LIMITED") result.rateLimited += 1
    else if (outcome === "DEAD_LETTER") result.deadLettered += 1
    else if (outcome === "RETRYING") result.retried += 1
    else result.failed += 1
  }

  return result
}

type JobOutcome =
  | "SUCCEEDED"
  | "PARTIAL"
  | "RETRYING"
  | "RATE_LIMITED"
  | "DEAD_LETTER"
  | "FAILED"

async function runOneJob(job: JobRow): Promise<JobOutcome> {
  const runs = await callTrusted<RunRow>("sync_run_start", { p_job_id: job.id })
  const runId = Array.isArray(runs) ? runs[0]?.id : runs?.id

  const contexts = await callTrusted<ContextRow[]>("sync_job_context", {
    p_job_id: job.id,
  })
  const context = contexts?.[0]

  if (!context || context.account_status === "DISCONNECTED") {
    return finish(job, runId, "FAILED", job.cursor, 0, 0, 0, "Connection is not active.")
  }

  const connector = getConnector(context.provider)
  if (!connector) {
    // A job for a provider this build does not ship. Not retryable: the next
    // attempt would find exactly the same thing.
    return finish(
      job, runId, "FAILED", job.cursor, 0, 0, 0,
      `No connector is registered for ${context.provider}.`
    )
  }

  let credentials: ConnectorCredentials = {}
  if (context.credentials_encrypted) {
    try {
      credentials = JSON.parse(
        decryptCredential(context.credentials_encrypted, {
          businessId: context.resolved_business_id,
          purpose: "api_credentials",
        })
      ) as ConnectorCredentials
    } catch {
      return finish(
        job, runId, "FAILED", job.cursor, 0, 0, 0,
        "Stored credentials could not be read."
      )
    }
  }

  let page
  try {
    page = await connector.fetchPage({
      context: {
        externalAccountId: context.external_account_id,
        credentials,
        metadata: context.metadata ?? {},
      },
      resource: context.resource as SyncResource,
      mode: context.mode as SyncMode,
      cursor: context.cursor_value,
    })
  } catch (error) {
    // A connector that throws is treated as a retryable failure. It is a bug,
    // but the right response to an unexpected bug is the cautious one.
    return finish(
      job, runId, "FAILED", job.cursor, 0, 0, 0,
      `Connector threw: ${error instanceof Error ? error.name : "unknown"}`
    )
  }

  /* ---- The engine decides the consequence of each signal ---------------- */

  if (page.kind === "rate_limited") {
    // Not a failure. The provider asked us to wait, so we wait, and the
    // attempt is refunded by sync_job_complete.
    await callTrusted("sync_job_complete", {
      p_job_id: job.id,
      p_run_id: runId,
      p_status: "RETRYING",
      p_cursor: job.cursor,
      p_records_fetched: 0,
      p_records_applied: 0,
      p_records_skipped: 0,
      p_error: page.reason,
      p_retry_after_ms: page.retryAfterMs,
    })
    return "RATE_LIMITED"
  }

  if (page.kind === "permanent_error") {
    // Retrying cannot fix a revoked token. Going straight to the state a
    // person can see beats burning seven attempts discovering that.
    await callTrusted("sync_job_complete", {
      p_job_id: job.id,
      p_run_id: runId,
      p_status: "DEAD_LETTER",
      p_cursor: job.cursor,
      p_records_fetched: 0,
      p_records_applied: 0,
      p_records_skipped: 0,
      p_error: page.reason,
      p_retry_after_ms: null,
    })
    return "DEAD_LETTER"
  }

  if (page.kind === "retryable_error") {
    return finish(job, runId, "FAILED", job.cursor, 0, 0, 0, page.reason)
  }

  /* ---- A page. Apply it, THEN checkpoint. ------------------------------- */

  const records = page.records
  let applied = 0
  let skipped = 0
  let error: string | null = null

  if (records.length > 0) {
    try {
      // Which apply function is a property of the RESOURCE, not the provider.
      // Both take a job id and derive the tenant from it, so neither can be
      // pointed at another business.
      const isProducts =
        context.resource === "PRODUCTS" || context.resource === "INVENTORY"

      const outcome = await callTrusted<ApplyResult>(
        isProducts ? "sync_apply_products" : "sync_apply_orders",
        { p_job_id: job.id, p_rows: records as unknown as RawRecord[] }
      )

      applied = isProducts
        ? (outcome?.products_created ?? 0) + (outcome?.products_updated ?? 0)
        : (outcome?.orders_created ?? 0) + (outcome?.orders_updated ?? 0)

      skipped = Math.max(records.length - applied, 0)
    } catch (applyError) {
      error =
        applyError instanceof Error
          ? applyError.message
          : "The page could not be applied."
    }
  }

  if (error !== null) {
    // The cursor is NOT advanced. The next attempt refetches this page, and
    // the (business_id, source, external_id) index makes that harmless.
    return finish(job, runId, "FAILED", job.cursor, records.length, applied, skipped, error)
  }

  // A page where some rows were rejected is PARTIAL, not FAILED. Discarding
  // the good rows because one was malformed loses real data to protect
  // nothing; the rejected ones are recorded by the import pipeline.
  const status = skipped > 0 ? "PARTIAL" : "SUCCEEDED"

  await callTrusted("sync_job_complete", {
    p_job_id: job.id,
    p_run_id: runId,
    p_status: status,
    p_cursor: page.hasMore ? page.nextCursor : page.nextCursor,
    p_records_fetched: records.length,
    p_records_applied: applied,
    p_records_skipped: skipped,
    p_error: null,
    p_retry_after_ms: null,
  })

  return status
}

/** Records a failure and lets the database decide retry versus dead letter. */
async function finish(
  job: JobRow,
  runId: string | undefined,
  status: "FAILED" | "SUCCEEDED" | "PARTIAL",
  cursor: string | null,
  fetched: number,
  applied: number,
  skipped: number,
  error: string | null
): Promise<JobOutcome> {
  const updated = await callTrusted<{ status: string }>("sync_job_complete", {
    p_job_id: job.id,
    p_run_id: runId,
    p_status: status,
    p_cursor: cursor,
    p_records_fetched: fetched,
    p_records_applied: applied,
    p_records_skipped: skipped,
    p_error: error,
    p_retry_after_ms: null,
  })

  const next = Array.isArray(updated) ? updated[0]?.status : updated?.status

  if (next === "DEAD_LETTER") return "DEAD_LETTER"
  if (next === "RETRYING") return "RETRYING"
  if (next === "SUCCEEDED" || next === "PARTIAL") return next
  return "FAILED"
}
