import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { ImportBatch, ImportIssue, ImportEntity, ImportStatus, ChannelType } from "@/types/database"

/**
 * Import history.
 *
 * `raw_rows` is deliberately excluded from the list query — a batch can hold
 * thousands of rows, and pulling them all back to render a table of filenames
 * would be slow for no benefit.
 */

export type ImportBatchSummary = Omit<ImportBatch, "raw_rows" | "columns" | "mapping" | "options">

export async function getImportHistory(limit = 25): Promise<ImportBatchSummary[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("import_batches")
    // One string literal, not a concatenation: Supabase infers the row type
    // from the literal, and splitting it across lines loses that inference.
    .select(
      "id, business_id, created_by, entity, status, source, channel_id, file_name, file_type, file_size_bytes, row_count, rows_valid, rows_failed, created_count, updated_count, error, created_at, updated_at, committed_at"
    )
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) throw new Error(`Could not load import history: ${error.message}`)
  return (data ?? []) as ImportBatchSummary[]
}

/**
 * One data source: an uploaded file, a sheet sync, or a webhook delivery, with
 * what it wrote and how well BizMind knows what that was.
 *
 * `lineage_status` is the honest part. RECORDED and RECOVERED can be
 * withdrawn; NONE and INCOMPLETE cannot, and the screen says why rather than
 * offering a button that would half-work.
 */
export type DataSource = {
  batch_id: string
  business_id: string
  entity: ImportEntity
  status: ImportStatus
  source: ChannelType | null
  file_name: string
  file_type: string
  created_at: string
  committed_at: string | null
  row_count: number
  rows_valid: number | null
  rows_failed: number | null
  created_count: number | null
  updated_count: number | null
  errors_count: number
  warnings_count: number
  lineage_status: "RECORDED" | "RECOVERED" | "INCOMPLETE" | "NONE"
  records_written: number
  records_withdrawn: number
  withdrawn_at: string | null
  withdrawal_reason: string | null
  connection_name: string | null
  matched_count: number
  /** LEGACY: orders, products, expenses. LEDGER: a marketplace settlement file (0031). */
  dataset: "LEGACY" | "LEDGER"
  format_id: string | null
  marketplace_account_id: string | null
  marketplace_label: string | null
  marketplace_code: string | null
  transactions_count: number
  settlements_count: number
  payouts_count: number
  unmapped_count: number
}

/** Every source of data in this business, newest first. */
export async function listDataSources(
  options: { limit?: number; offset?: number } = {}
): Promise<{ rows: DataSource[]; matchedCount: number }> {
  const supabase = await createClient()

  const { data, error } = await supabase.rpc("import_batch_overview", {
    p_limit: options.limit ?? 50,
    p_offset: options.offset ?? 0,
  })

  if (error) throw new Error(`Could not load your data sources: ${error.message}`)

  const rows = (data as DataSource[]) ?? []
  return { rows, matchedCount: rows[0]?.matched_count ?? 0 }
}

/** One source, for its detail page. */
export async function getDataSource(batchId: string): Promise<DataSource | null> {
  const { rows } = await listDataSources({ limit: 200 })
  return rows.find((row) => row.batch_id === batchId) ?? null
}

/**
 * What withdrawing this import would do — the numbers the confirmation shows.
 *
 * Read-only, and computed from the same rule the withdrawal itself applies, so
 * the confirmation cannot promise something different from what happens.
 */
export type WithdrawalPreview = {
  batch_id: string
  file_name: string
  entity: ImportEntity
  lineage_status: string
  already_withdrawn: boolean
  can_withdraw: boolean
  blocked_reason: string | null
  records_written: number
  records_created: number
  records_updated: number
  records_exclusive: number
  records_shared: number
  orders_exclusive: number
  products_exclusive: number
  expenses_exclusive: number
  shared_with: string[]
}

export async function getWithdrawalPreview(
  batchId: string
): Promise<WithdrawalPreview | null> {
  const supabase = await createClient()

  const { data, error } = await supabase.rpc("import_batch_withdrawal_preview", {
    p_batch_id: batchId,
  })

  if (error) {
    console.error("[imports] withdrawal preview failed", error.message)
    return null
  }

  return ((data as WithdrawalPreview[]) ?? [])[0] ?? null
}

/**
 * A marketplace file's ledger lines, grouped by what they are.
 *
 * Totals are exact decimal text added up by the database; this module passes
 * them through untouched. Withdrawn files still show their lines: the evidence
 * is kept, it just counts towards nothing.
 */
export type LedgerFileCategory = {
  side: "PNL" | "CASH" | "TAX" | "MEMO" | null
  category: string
  subcategory: string | null
  lines: number
  total: string
  currency: string
}

export async function getLedgerFileSummary(sourceFileId: string): Promise<LedgerFileCategory[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("ledger_file_summary", { p_source_file_id: sourceFileId })
  if (error) throw new Error(`Could not load this file's lines: ${error.message}`)
  return data ?? []
}

/** Each settlement in a marketplace file: the marketplace's total against the sum of its lines. */
export type LedgerFileSettlement = {
  settlement_id: string
  external_settlement_id: string
  period_start: string | null
  period_end: string | null
  reported_total: string | null
  lines_total: string
  reconciles: boolean
  reported_deposit_date: string | null
  payout_amount: string | null
  currency: string
}

export async function getLedgerFileSettlements(sourceFileId: string): Promise<LedgerFileSettlement[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("ledger_file_settlements", { p_source_file_id: sourceFileId })
  if (error) throw new Error(`Could not load this file's settlements: ${error.message}`)
  return data ?? []
}

export async function getImportIssues(batchId: string, limit = 200): Promise<ImportIssue[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("import_issues")
    .select("*")
    .eq("batch_id", batchId)
    .order("row_number", { ascending: true })
    .limit(limit)

  if (error) throw new Error(`Could not load import issues: ${error.message}`)
  return (data ?? []) as ImportIssue[]
}
