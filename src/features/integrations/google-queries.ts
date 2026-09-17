import "server-only"

import { isEncryptionConfigured } from "@/lib/crypto"
import { createClient } from "@/lib/supabase/server"
import type { SheetEntityKey } from "@/services/ingestion/contracts"
import { isSheetEntityKey } from "@/services/ingestion/entities"
import {
  googleClientId,
  googleOAuthConfig,
} from "@/services/integrations/connectors/google-sheets/oauth"
import { isPrivilegedAccessConfigured } from "@/services/integrations/security/privileged"
import type { IntegrationStatus, SyncMode, SyncStatus, SyncTrigger } from "@/types/database"

/**
 * Google Sheets, for the Integrations page.
 *
 * Every query runs as the signed-in user, under RLS, and is narrowed to the
 * business they are working in. Nothing here reads a credential: the stored
 * Google authorisation is not selectable at all -- only WHEN it was granted.
 */

const RUNS_SHOWN = 6
const ISSUES_SHOWN = 10
/** A queued job nobody has picked up for this long is waiting for a nudge. */
const STALLED_AFTER_MS = 90_000

export type GoogleSetup = {
  /** Every setting the sign-in, the picker and the background worker need is present. */
  ready: boolean
  /** Public by design: the browser needs these to open Google's own picker. */
  clientId: string | null
  projectNumber: string | null
  pickerApiKey: string | null
  /** When this business connected Google, or null if it has not. */
  authorizedAt: string | null
}

export async function getGoogleSetup(businessId: string): Promise<GoogleSetup> {
  const clientId = googleClientId()
  const projectNumber = process.env.NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER?.trim() || null
  const pickerApiKey = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY?.trim() || null

  const ready =
    googleOAuthConfig() !== null &&
    isEncryptionConfigured() &&
    isPrivilegedAccessConfigured() &&
    clientId !== null &&
    projectNumber !== null &&
    pickerApiKey !== null

  const supabase = await createClient()
  const { data } = await supabase
    .from("integrations")
    .select("authorized_at")
    .eq("business_id", businessId)
    .eq("provider", "GOOGLE_SHEETS")
    .maybeSingle()

  return { ready, clientId, projectNumber, pickerApiKey, authorizedAt: data?.authorized_at ?? null }
}

export type SheetEntity = SheetEntityKey

export type SheetRun = {
  id: string
  startedAt: string
  completedAt: string | null
  status: SyncStatus
  trigger: SyncTrigger | null
  inserted: number | null
  updated: number | null
  unchanged: number | null
  rejected: number | null
  error: string | null
}

export type SheetIssue = {
  rowNumber: number
  severity: "ERROR" | "WARNING"
  field: string | null
  message: string
  rawValue: string | null
}

export type SheetConnection = {
  accountId: string
  displayName: string | null
  spreadsheetId: string | null
  spreadsheetName: string | null
  sheetId: number | null
  sheetTitle: string | null
  entity: SheetEntity | null
  mapping: Record<string, string>
  dateFormat: string | null
  decimalSeparator: string | null
  channelType: string | null
  status: IntegrationStatus
  lastError: string | null
  lastSuccessfulSyncAt: string | null
  job: {
    status: SyncStatus
    mode: SyncMode
    nextRunAt: string
    lastError: string | null
    /** Queued, due, and not picked up: nothing is working on it right now. */
    stalled: boolean
  } | null
  runs: SheetRun[]
  /** Records BizMind holds that the last complete read did not find. */
  missingCount: number
  issues: SheetIssue[]
  issuesTotal: number
}

function readMetadata(metadata: unknown) {
  const m = (metadata ?? {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === "string" ? value : null)

  const mapping: Record<string, string> = {}
  if (m.mapping !== null && typeof m.mapping === "object") {
    for (const [field, column] of Object.entries(m.mapping as Record<string, unknown>)) {
      if (typeof column === "string") mapping[field] = column
    }
  }

  return {
    spreadsheetId: text(m.spreadsheet_id),
    spreadsheetName: text(m.spreadsheet_name),
    sheetId: typeof m.sheet_id === "number" ? m.sheet_id : null,
    sheetTitle: text(m.sheet_title),
    entity:
      isSheetEntityKey(m.entity)
        ? m.entity
        : null,
    mapping,
    dateFormat: text(m.date_format),
    decimalSeparator: text(m.decimal_separator),
  }
}

/** Every connected (not disconnected) Google Sheets tab of this business. */
export async function listSheetConnections(businessId: string): Promise<SheetConnection[]> {
  const supabase = await createClient()

  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, display_name, status, metadata, channel_id, last_error, last_successful_sync_at")
    .eq("business_id", businessId)
    .eq("provider", "GOOGLE_SHEETS")
    .neq("status", "DISCONNECTED")
    .order("connected_at", { ascending: false })

  if (!accounts || accounts.length === 0) return []

  const accountIds = accounts.map((a) => a.id)

  const { data: jobs } = await supabase
    .from("sync_jobs")
    .select("id, integration_account_id, status, mode, next_run_at, last_error")
    .in("integration_account_id", accountIds)

  const jobOf = new Map((jobs ?? []).map((job) => [job.integration_account_id, job]))

  const channelIds = accounts.map((a) => a.channel_id).filter((id): id is string => id !== null)
  const channelTypeOf = new Map<string, string>()
  if (channelIds.length > 0) {
    const { data: channels } = await supabase.from("channels").select("id, type").in("id", channelIds)
    for (const channel of channels ?? []) channelTypeOf.set(channel.id, channel.type)
  }

  const now = Date.now()

  return Promise.all(
    accounts.map(async (account): Promise<SheetConnection> => {
      const job = jobOf.get(account.id) ?? null

      const [runs, missing, batches] = await Promise.all([
        job
          ? supabase
              .from("sync_runs")
              .select(
                "id, started_at, completed_at, status, trigger, rows_inserted, rows_updated, rows_unchanged, rows_rejected, error_summary"
              )
              .eq("job_id", job.id)
              .order("started_at", { ascending: false })
              .limit(RUNS_SHOWN)
          : null,
        supabase
          .from("integration_record_state")
          .select("id", { count: "exact", head: true })
          .eq("integration_account_id", account.id)
          .eq("present", false),
        supabase
          .from("import_batches")
          .select("id")
          .eq("integration_account_id", account.id)
          .order("created_at", { ascending: false })
          .limit(20),
      ])

      const batchIds = (batches.data ?? []).map((b) => b.id)
      const issues =
        batchIds.length > 0
          ? await supabase
              .from("import_issues")
              .select("row_number, severity, field, message, raw_value", { count: "exact" })
              .in("batch_id", batchIds)
              .order("created_at", { ascending: false })
              .limit(ISSUES_SHOWN)
          : null

      const meta = readMetadata(account.metadata)

      return {
        accountId: account.id,
        displayName: account.display_name,
        ...meta,
        channelType: account.channel_id ? (channelTypeOf.get(account.channel_id) ?? null) : null,
        status: account.status,
        lastError: account.last_error,
        lastSuccessfulSyncAt: account.last_successful_sync_at,
        job: job
          ? {
              status: job.status,
              mode: job.mode,
              nextRunAt: job.next_run_at,
              lastError: job.last_error,
              stalled:
                job.status === "QUEUED" && now - Date.parse(job.next_run_at) > STALLED_AFTER_MS,
            }
          : null,
        runs: (runs?.data ?? []).map((run) => ({
          id: run.id,
          startedAt: run.started_at,
          completedAt: run.completed_at,
          status: run.status,
          trigger: run.trigger,
          inserted: run.rows_inserted,
          updated: run.rows_updated,
          unchanged: run.rows_unchanged,
          rejected: run.rows_rejected,
          error: run.error_summary,
        })),
        missingCount: missing.count ?? 0,
        issues: (issues?.data ?? []).map((issue) => ({
          rowNumber: issue.row_number,
          severity: issue.severity,
          field: issue.field,
          message: issue.message,
          rawValue: issue.raw_value,
        })),
        issuesTotal: issues?.count ?? 0,
      }
    })
  )
}
