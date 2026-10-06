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

/**
 * All parts of a file recorded in parts (a large settlement), at once.
 *
 * Withdrawing only one part of February would leave the month half counted, so
 * the screen offers the whole file. Each part is still its own withdrawal in the
 * database, audited on its own; they run one after another and stop at the first
 * that fails, saying how many were done. Nothing is deleted, and running it again
 * only touches the parts still to do.
 */
const idsSchema = z.array(z.string().uuid()).min(1).max(60)

export type LedgerFilesActionResult =
  | { ok: true; files: number; transactions: number; settlements: number; payouts: number }
  | { ok: false; error: string; done: number }

export async function withdrawLedgerFilesAction(sourceFileIds: string[], reason: string): Promise<LedgerFilesActionResult> {
  const ids = idsSchema.safeParse(sourceFileIds)
  if (!ids.success) return { ok: false, error: "Those files could not be found.", done: 0 }

  const total = { files: 0, transactions: 0, settlements: 0, payouts: 0 }
  for (const id of ids.data) {
    const result = await withdrawLedgerFile(id, reason.trim().slice(0, 500) || null)
    if (!result.ok) {
      revalidatePath("/imports")
      return {
        ok: false,
        done: total.files,
        error: `${result.error}${total.files > 0 ? ` ${total.files} of ${ids.data.length} parts were withdrawn first; run it again to finish.` : ""}`,
      }
    }
    total.files += 1
    total.transactions += result.value.transactions
    total.settlements += result.value.settlements
    total.payouts += result.value.payouts
  }

  revalidatePath("/imports")
  for (const id of ids.data) revalidatePath(`/imports/${id}`)
  return { ok: true, ...total }
}

export async function restoreLedgerFilesAction(sourceFileIds: string[]): Promise<LedgerFilesActionResult> {
  const ids = idsSchema.safeParse(sourceFileIds)
  if (!ids.success) return { ok: false, error: "Those files could not be found.", done: 0 }

  const total = { files: 0, transactions: 0, settlements: 0, payouts: 0 }
  for (const id of ids.data) {
    const result = await restoreLedgerFile(id)
    if (!result.ok) {
      revalidatePath("/imports")
      return {
        ok: false,
        done: total.files,
        error: `${result.error}${total.files > 0 ? ` ${total.files} of ${ids.data.length} parts were put back first; run it again to finish.` : ""}`,
      }
    }
    total.files += 1
    total.transactions += result.value.transactions
    total.settlements += result.value.settlements
    total.payouts += result.value.payouts
  }

  revalidatePath("/imports")
  for (const id of ids.data) revalidatePath(`/imports/${id}`)
  return { ok: true, ...total }
}
