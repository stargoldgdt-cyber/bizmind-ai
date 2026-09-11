"use server"

import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import {
  getSpreadsheet,
  getValues,
  isSpreadsheetId,
  rowsRange,
  type GoogleFailure,
} from "@/services/integrations/connectors/google-sheets/client"
import {
  displayRecord,
  headingsFrom,
  recordsFrom,
} from "@/services/integrations/connectors/google-sheets/table"

/**
 * Choosing a sheet: listing a spreadsheet's tabs and previewing one.
 *
 * WHOSE TOKEN
 * -----------
 * These run while the owner is choosing, before a connection exists. They use
 * the short-lived access token the owner's BROWSER got from Google for the
 * Picker -- used once, never stored, never logged. The business's stored
 * Google authorisation is not touched: that is used only by the background
 * worker, so no person's request ever depends on it.
 *
 * The token reaches only Google, at fixed hosts, and the spreadsheet id is
 * validated against Google's alphabet first -- there is no URL here an owner
 * could point somewhere else.
 */

const PREVIEW_ROWS = 20

const pickSchema = z.object({
  spreadsheetId: z.string().refine(isSpreadsheetId, "That is not a Google spreadsheet."),
  /** The browser's own short-lived Google token. Bounded, never stored. */
  accessToken: z.string().min(20).max(4096),
})

const previewSchema = pickSchema.extend({
  sheetId: z.number().int().min(0),
})

type Failure = { ok: false; error: string }

function explain(failure: GoogleFailure): string {
  if (failure.kind === "rate_limited") {
    return "Google is busy right now. Wait a minute and try again."
  }
  if (failure.kind === "retryable_error") {
    return "Google did not respond. Try again in a moment."
  }
  if (failure.code === "REAUTH_REQUIRED") {
    return "Your Google session expired. Choose the spreadsheet again."
  }
  if (failure.code === "ACCESS_DENIED" || failure.code === "SOURCE_GONE") {
    return (
      "BizMind cannot open that spreadsheet. Choose it again, using the same " +
      "Google account you connected."
    )
  }
  return "That spreadsheet could not be opened."
}

async function mayConnect(): Promise<boolean> {
  const business = await getActiveBusiness()
  return business !== null && (business.role === "OWNER" || business.role === "ADMIN")
}

/** The tabs of a spreadsheet the owner just picked. */
export async function listGoogleTabsAction(
  rawInput: unknown
): Promise<
  | { ok: true; title: string; tabs: { sheetId: number; title: string; rowCount: number }[] }
  | Failure
> {
  if (!(await mayConnect())) {
    return { ok: false, error: "Only an owner or admin can connect a spreadsheet." }
  }

  const parsed = pickSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That spreadsheet could not be read." }

  const sheet = await getSpreadsheet(parsed.data.accessToken, parsed.data.spreadsheetId, fetch)
  if (sheet.kind !== "ok") return { ok: false, error: explain(sheet) }

  return {
    ok: true,
    title: sheet.body.title,
    tabs: sheet.body.tabs.map((t) => ({ sheetId: t.sheetId, title: t.title, rowCount: t.rowCount })),
  }
}

/**
 * The headings and first rows of one tab -- what the mapping step needs.
 *
 * Values are returned as the exact text Google sent. Nothing is converted, so
 * the owner sees the same digits BizMind will store.
 */
export async function previewGoogleTabAction(
  rawInput: unknown
): Promise<
  | { ok: true; tabTitle: string; headers: string[]; rows: Record<string, string>[] }
  | Failure
> {
  if (!(await mayConnect())) {
    return { ok: false, error: "Only an owner or admin can connect a spreadsheet." }
  }

  const parsed = previewSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That tab could not be read." }

  const { accessToken, spreadsheetId, sheetId } = parsed.data

  const sheet = await getSpreadsheet(accessToken, spreadsheetId, fetch)
  if (sheet.kind !== "ok") return { ok: false, error: explain(sheet) }

  const tab = sheet.body.tabs.find((t) => t.sheetId === sheetId)
  if (!tab) return { ok: false, error: "That tab no longer exists in the spreadsheet." }

  const values = await getValues(
    accessToken,
    spreadsheetId,
    [rowsRange(tab.title, 1, 1), rowsRange(tab.title, 2, 1 + PREVIEW_ROWS)],
    fetch
  )
  if (values.kind !== "ok") return { ok: false, error: explain(values) }

  const headers = headingsFrom(values.body[0]?.[0] ?? [])
  if (headers.every((heading) => heading === "")) {
    return {
      ok: false,
      error:
        "The first row of this tab has no column headings. Add a heading above " +
        "each column, then choose it again.",
    }
  }

  const { records } = recordsFrom(headers, values.body[1] ?? [], 2)

  return {
    ok: true,
    tabTitle: tab.title,
    headers: headers.filter((heading) => heading !== ""),
    rows: records.map(displayRecord),
  }
}
