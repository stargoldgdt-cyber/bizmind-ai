import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { Json } from "@/types/database"

import type { LedgerFilePayload } from "./ledger-file"

/**
 * The application's door to the ledger writer.
 *
 * Three calls, all through the signed-in user's own session, never the service
 * role. The database decides the tenant from the marketplace account or file,
 * checks the role, and is the only thing that writes (migration 0030):
 *
 *   applyLedgerFile     ledger_apply_file()     OWNER, ADMIN, STAFF
 *   withdrawLedgerFile  ledger_file_withdraw()  OWNER, ADMIN
 *   restoreLedgerFile   ledger_file_restore()   OWNER, ADMIN
 *
 * Nothing here inserts into a ledger table, and nothing can: those tables grant
 * signed-in users SELECT only, and a trigger refuses even the service role.
 */

export type LedgerApplyResult = {
  source_file_id: string
  /** True when this exact file already counts for the account. Nothing was written. */
  duplicate: boolean
  rows_written: number
  transactions_written: number
  settlements_written: number
  payouts_written: number
  issues_written: number
  unmapped_written: number
}

export type LedgerFileChange = {
  transactions: number
  settlements: number
  payouts: number
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string }

export async function applyLedgerFile(payload: LedgerFilePayload): Promise<Outcome<LedgerApplyResult>> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("ledger_apply_file", {
    p_file: payload as unknown as Json,
  })

  // The database's own wording is written for the owner ("A viewer cannot
  // import data.", "Settlement S1 is already counted from ..."), and carries no
  // SQL or identifiers of other businesses.
  if (error) return { ok: false, error: error.message }

  const row = data?.[0]
  if (!row) return { ok: false, error: "The ledger did not confirm the file." }
  return { ok: true, value: row }
}

export async function withdrawLedgerFile(
  sourceFileId: string,
  reason: string | null
): Promise<Outcome<LedgerFileChange>> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("ledger_file_withdraw", {
    p_source_file_id: sourceFileId,
    p_reason: reason,
  })

  if (error) return { ok: false, error: error.message }

  const row = data?.[0]
  if (!row) return { ok: false, error: "The ledger did not confirm the withdrawal." }
  return {
    ok: true,
    value: {
      transactions: row.transactions_withdrawn,
      settlements: row.settlements_withdrawn,
      payouts: row.payouts_withdrawn,
    },
  }
}

export async function restoreLedgerFile(sourceFileId: string): Promise<Outcome<LedgerFileChange>> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("ledger_file_restore", {
    p_source_file_id: sourceFileId,
  })

  if (error) return { ok: false, error: error.message }

  const row = data?.[0]
  if (!row) return { ok: false, error: "The ledger did not confirm the restore." }
  return {
    ok: true,
    value: {
      transactions: row.transactions_restored,
      settlements: row.settlements_restored,
      payouts: row.payouts_restored,
    },
  }
}
