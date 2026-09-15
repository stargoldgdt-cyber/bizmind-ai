"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { restoreLedgerFile, withdrawLedgerFile } from "@/services/marketplaces/apply"

/**
 * Withdrawing and restoring a marketplace (ledger) file.
 *
 * The database does the work and the checking: OWNER or ADMIN, the file's own
 * business, nothing deleted, never double counted, always audited
 * (ledger_file_withdraw / ledger_file_restore, migration 0030).
 */

const idSchema = z.string().uuid()

export type LedgerFileActionResult =
  | { ok: true; transactions: number; settlements: number; payouts: number }
  | { ok: false; error: string }

export async function withdrawLedgerFileAction(
  sourceFileId: string,
  reason: string
): Promise<LedgerFileActionResult> {
  const id = idSchema.safeParse(sourceFileId)
  if (!id.success) return { ok: false, error: "That file could not be found." }

  const result = await withdrawLedgerFile(id.data, reason.trim().slice(0, 500) || null)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath("/imports")
  revalidatePath(`/imports/${id.data}`)
  return { ok: true, ...result.value }
}

export async function restoreLedgerFileAction(sourceFileId: string): Promise<LedgerFileActionResult> {
  const id = idSchema.safeParse(sourceFileId)
  if (!id.success) return { ok: false, error: "That file could not be found." }

  const result = await restoreLedgerFile(id.data)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath("/imports")
  revalidatePath(`/imports/${id.data}`)
  return { ok: true, ...result.value }
}
