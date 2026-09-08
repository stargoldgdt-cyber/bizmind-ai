import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { ImportBatch, ImportIssue } from "@/types/database"

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
