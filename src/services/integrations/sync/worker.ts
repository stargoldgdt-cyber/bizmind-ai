import "server-only"

import { decryptCredential } from "@/lib/crypto"
import type { RawRecord, RowIssue } from "@/services/ingestion/contracts"
import {
  getConnector,
  type ConnectorCredentials,
  type FetchResult,
  type SyncMode,
  type SyncResource,
} from "@/services/integrations/contract"
import { callTrusted } from "@/services/integrations/security/privileged"

import { prepareTabularPage, readSheetSettings } from "./tabular"

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

/**
 * How soon a parked job is looked at again. The connection's state -- waiting
 * for Google to be reconnected, or for a mapping review -- is what actually
 * holds it; this only stops it being reconsidered in a tight loop.
 */
const PARKED_RETRY_MS = 60_000

/** Row problems reported per page: the cap an upload's preview uses. */
const MAX_REPORTED_ISSUES = 500

export type WorkerResult = {
  claimed: number
  succeeded: number
  retried: number
  rateLimited: number
  deadLettered: number
  failed: number
}

export type JobRow = {
  id: string
  business_id: string
  integration_account_id: string
  resource: string
  mode: string
  cursor: string | null
  attempts: number
  max_attempts: number
}

export type ContextRow = {
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
  /** Migration 0023. Validation refuses other currencies, as an upload does. */
  business_currency: string
}

type RunRow = { id: string }

type ApplyResult = {
  orders_created?: number
  orders_updated?: number
  items_written?: number
  products_created?: number
  products_updated?: number
  expenses_created?: number
  expenses_updated?: number
  /** Phase 7 datasets: dated costs added, and costs replaced because the sheet changed them. */
  costs_added?: number
  costs_replaced?: number
  batch_id?: string
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
    // Waiting for a person is not the same as broken. Google needing to be
    // reconnected, or a sheet whose columns changed, parks the job until the
    // owner acts -- see park().
    if (page.code === "REAUTH_REQUIRED" || page.code === "MAPPING_REVIEW_REQUIRED") {
      return park(job, runId, context.account_id, page.code, page.reason)
    }

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

  /* ---- A spreadsheet page: mapped, validated, only changes written ----- */

  if (page.table) {
    return applyTabularPage(job, runId, context, { ...page, table: page.table })
  }

  /* ---- A page. Apply it, THEN checkpoint. ------------------------------- */

  const records = page.records
  let applied = 0
  let skipped = 0
  let error: string | null = null

  if (records.length > 0) {
    try {
      // Which apply function is a property of the RESOURCE, not the provider.
      // Each takes a job id and derives the tenant from it, so none can be
      // pointed at another business.
      const outcome = await callTrusted<ApplyResult>(
        applyFunctionFor(context.resource),
        { p_job_id: job.id, p_rows: records as unknown as RawRecord[] }
      )

      const counts = writtenCounts(outcome)
      applied = counts.inserted + counts.updated

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
    p_cursor: page.nextCursor,
    p_records_fetched: records.length,
    p_records_applied: applied,
    p_records_skipped: skipped,
    p_error: null,
    p_retry_after_ms: null,
    // Without this the engine stopped after page one of every resource: the
    // job was marked SUCCEEDED and nothing re-queued it. With more to come,
    // migration 0020 puts the job straight back in the queue at its cursor.
    p_has_more: page.hasMore,
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

/* -------------------------------------------------------------------------- */
/* Spreadsheet pages                                                          */
/* -------------------------------------------------------------------------- */

type PageResult = Extract<FetchResult, { kind: "page" }>
type TabularPage = PageResult & { table: NonNullable<PageResult["table"]> }

type Classification = {
  new?: string[]
  changed?: string[]
  unchanged?: number
  repeated?: string[]
}

/**
 * A spreadsheet page: the owner's confirmed mapping applied through the same
 * validate() every upload uses, then ONLY what changed written, through the
 * same apply functions as every other sync.
 *
 * The order is the one above -- write, report, remember what was seen, and
 * only then move the cursor. Cut off anywhere before the last step, the page
 * is read again, and everything already written then reads as unchanged.
 *
 * Exported for the live test, which hands it a page without Google.
 */
export async function applyTabularPage(
  job: JobRow,
  runId: string | undefined,
  context: ContextRow,
  page: TabularPage
): Promise<JobOutcome> {
  const fit = readSheetSettings(context.metadata ?? {}, page.table.headers)
  if (!fit.ok) {
    return park(job, runId, context.account_id, "MAPPING_REVIEW_REQUIRED", fit.reason)
  }

  const prepared = prepareTabularPage({
    settings: fit.settings,
    businessCurrency: context.business_currency,
    records: page.records,
    rowNumbers: page.table.rowNumbers,
  })

  const passId = page.table.passId ?? null
  let written = { inserted: 0, updated: 0 }
  let rejected = prepared.unkeyedRows
  let unchanged = 0

  try {
    const classified = await callTrusted<Classification>("sync_record_state_classify", {
      p_job_id: job.id,
      p_items: prepared.records.map(({ key, hash, locator }) => ({ key, hash, locator })),
      p_pass_id: passId,
    })

    const fresh = new Set([...(classified?.new ?? []), ...(classified?.changed ?? [])])
    unchanged = classified?.unchanged ?? 0

    // An order met twice in one pass, in rows read separately. Writing the
    // second part would replace the first part's lines, so it is refused and
    // reported. Products and expenses have no lines: the later row wins, as
    // it does in an upload.
    const split = new Set(fit.settings.entity === "ORDERS" ? (classified?.repeated ?? []) : [])

    const toWrite = prepared.records.filter(
      (r) => fresh.has(r.key) && r.row !== null && !split.has(r.key)
    )
    rejected += prepared.records.filter(
      (r) => split.has(r.key) || (fresh.has(r.key) && r.row === null)
    ).length

    // A problem is reported when its record is new or changed -- not again on
    // every pass while nobody has touched the row.
    const reportable = new Set([...fresh, ...split])
    const issues: RowIssue[] = prepared.issues
      .filter((entry) => entry.key === null || reportable.has(entry.key))
      .map((entry) => entry.issue)

    for (const record of prepared.records) {
      if (!split.has(record.key)) continue
      issues.push({
        rowNumber: record.locator.rows[0] ?? 0,
        severity: "ERROR",
        field: "external_id",
        message:
          `Order "${record.key}" also appears higher up this sheet, apart from these rows. ` +
          `BizMind reads an order's rows together, so keep every row of an order next to ` +
          `each other. These rows were not imported.`,
      })
    }

    let batchId: string | null = null

    if (toWrite.length > 0) {
      const outcome = await callTrusted<ApplyResult>(applyFunctionFor(context.resource), {
        p_job_id: job.id,
        p_rows: toWrite.map((r) => r.row),
      })
      batchId = outcome?.batch_id ?? null
      written = writtenCounts(outcome)
    }

    if (issues.length > 0) {
      await callTrusted("sync_record_issues", {
        p_job_id: job.id,
        p_batch_id: batchId,
        p_issues: issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
          row_number: issue.rowNumber,
          severity: issue.severity,
          field: issue.field ?? null,
          message: issue.message,
          raw_value: issue.rawValue ?? null,
        })),
        p_rows_valid: toWrite.length,
        p_rows_failed: rejected,
      })
    }

    // A split order is not remembered, so its first part stays the version
    // on record and the split is reported again until the sheet is fixed.
    await callTrusted("sync_record_state_commit", {
      p_job_id: job.id,
      p_run_id: runId ?? null,
      p_items: prepared.records
        .filter((r) => !split.has(r.key))
        .map((r) => ({
          key: r.key,
          hash: r.hash,
          locator: r.locator,
          outcome: fresh.has(r.key) ? (r.row === null ? "REJECTED" : "APPLIED") : null,
        })),
      p_pass_id: passId,
    })

    // The last page of a complete pass: whatever was not seen in it is no
    // longer in the sheet. Marked, never deleted.
    if (!page.hasMore && passId) {
      await callTrusted("sync_record_state_mark_missing", {
        p_job_id: job.id,
        p_pass_id: passId,
      })
    }
  } catch (error) {
    // Nothing is checkpointed. The page is read again, and whatever was
    // already written then reads as unchanged.
    return finish(
      job, runId, "FAILED", job.cursor, page.records.length,
      written.inserted + written.updated, rejected,
      error instanceof Error ? error.message : "The page could not be applied."
    )
  }

  const status = rejected > 0 ? "PARTIAL" : "SUCCEEDED"

  await callTrusted("sync_job_complete", {
    p_job_id: job.id,
    p_run_id: runId,
    p_status: status,
    p_cursor: page.nextCursor,
    p_records_fetched: page.records.length,
    p_records_applied: written.inserted + written.updated,
    p_records_skipped: rejected,
    p_error: null,
    p_retry_after_ms: null,
    p_has_more: page.hasMore,
    p_rows_inserted: written.inserted,
    p_rows_updated: written.updated,
    p_rows_unchanged: unchanged,
    p_rows_rejected: rejected,
  })

  return status
}

/**
 * Parks a job until a person acts: Google needs reconnecting, or the sheet no
 * longer fits its mapping.
 *
 * Not a dead letter. The connection's state stops the job being claimed, and
 * the owner's fix -- reconnecting Google, or confirming the columns again --
 * turns the connection back to CONNECTED, at which point the job simply runs.
 * A dead letter would need a second rescue that nothing performs. The attempt
 * is refunded, as for a rate limit: waiting for a person is not a failure.
 */
async function park(
  job: JobRow,
  runId: string | undefined,
  accountId: string,
  state: "REAUTH_REQUIRED" | "MAPPING_REVIEW_REQUIRED",
  reason: string
): Promise<JobOutcome> {
  await callTrusted("integration_account_set_state", {
    p_account_id: accountId,
    p_status: state,
    p_reason: reason,
  })

  await callTrusted("sync_job_complete", {
    p_job_id: job.id,
    p_run_id: runId,
    p_status: "RETRYING",
    p_cursor: job.cursor,
    p_records_fetched: 0,
    p_records_applied: 0,
    p_records_skipped: 0,
    p_error: reason,
    p_retry_after_ms: PARKED_RETRY_MS,
  })

  return "RETRYING"
}

/** Which apply function is a property of the RESOURCE, not the provider. */
function applyFunctionFor(
  resource: string
):
  | "sync_apply_orders"
  | "sync_apply_products"
  | "sync_apply_expenses"
  | "sync_apply_catalog"
  | "sync_apply_product_costs" {
  if (resource === "PRODUCTS" || resource === "INVENTORY") return "sync_apply_products"
  if (resource === "EXPENSES") return "sync_apply_expenses"
  // Phase 7 datasets: the product master and dated costs (migration 0037).
  if (resource === "CATALOG") return "sync_apply_catalog"
  if (resource === "PRODUCT_COSTS") return "sync_apply_product_costs"
  return "sync_apply_orders"
}

/** Records created and updated, whichever kind of record was written. */
function writtenCounts(outcome: ApplyResult | null | undefined) {
  return {
    inserted:
      (outcome?.orders_created ?? 0) +
      (outcome?.products_created ?? 0) +
      (outcome?.expenses_created ?? 0) +
      (outcome?.costs_added ?? 0),
    updated:
      (outcome?.orders_updated ?? 0) +
      (outcome?.products_updated ?? 0) +
      (outcome?.expenses_updated ?? 0) +
      (outcome?.costs_replaced ?? 0),
  }
}
