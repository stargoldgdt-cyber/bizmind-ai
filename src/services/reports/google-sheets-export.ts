import "server-only"

import { classifyGoogleError, type GoogleResult } from "@/services/integrations/connectors/google-sheets/client"
import type { FetchLike } from "@/services/integrations/connectors/google-sheets/oauth"

import type { Cell, CellKind, Report } from "./catalog"
import { spreadsheetNumber } from "./xlsx"

/**
 * The ONLY code in BizMind that writes to Google Sheets (GCC Phase 8).
 *
 * WRITE SCOPE (decision A5)
 * -------------------------
 * BizMind writes only to a spreadsheet it has just created for an export:
 *   1. createReportSpreadsheet() creates a NEW spreadsheet and returns a
 *      CreatedSpreadsheet -- a value only this module can make.
 *   2. fillReportSpreadsheet() accepts nothing else. There is no function here
 *      that takes a spreadsheet id as text, so no caller can point a write at a
 *      sheet the owner already has.
 * The sync connector's client stays read-only (scripts/verify-google-sheets.mts).
 *
 * VALUES
 * ------
 * Written with valueInputOption RAW: Google stores each value as given and
 * never evaluates it, so a cell can never become a formula. A figure is sent
 * as a number only when no digit would be lost (see ./xlsx.ts), otherwise as
 * its exact text; a blank figure is an empty cell.
 */

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"
const TIMEOUT_MS = 30_000
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/

const CREATED: unique symbol = Symbol("created by BizMind")

export type CreatedSpreadsheet = {
  readonly [CREATED]: true
  readonly spreadsheetId: string
  /** Always the created spreadsheet's own link, built here. */
  readonly spreadsheetUrl: string
  readonly sheetTitles: readonly string[]
}

export function sheetTitles(report: Report): string[] {
  return ["About", ...report.sheets.map((s) => s.name.slice(0, 100))]
}

export async function createReportSpreadsheet(
  accessToken: string,
  report: Report,
  title: string,
  fetchImpl: FetchLike = fetch
): Promise<GoogleResult<CreatedSpreadsheet>> {
  const titles = sheetTitles(report)
  const sent = await post(SHEETS, accessToken, {
    properties: { title: title.slice(0, 200) },
    sheets: titles.map((name, index) => ({ properties: { title: name, index } })),
  }, fetchImpl)
  if (sent.kind !== "ok") return sent

  const id = typeof sent.body.spreadsheetId === "string" ? sent.body.spreadsheetId : ""
  if (!SPREADSHEET_ID.test(id)) {
    return { kind: "retryable_error", reason: "Google did not return the new spreadsheet." }
  }
  return {
    kind: "ok",
    body: {
      [CREATED]: true,
      spreadsheetId: id,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
      sheetTitles: titles,
    },
  }
}

function sheetValue(value: Cell, kind: CellKind): string | number {
  if (value === null) return ""
  if (typeof value === "number") return value
  if (kind === "money" || kind === "count" || kind === "percent") return spreadsheetNumber(value)
  if (kind === "date") return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value
  return value
}

export function reportValues(report: Report): { range: string; values: (string | number)[][] }[] {
  const a1 = (title: string) => `'${title.replace(/'/g, "''")}'!A1`
  return [
    {
      range: a1("About"),
      values: [[report.title], [], ...report.about.map(([label, text]) => [label, text])],
    },
    ...report.sheets.map((sheet) => ({
      range: a1(sheet.name.slice(0, 100)),
      values: [
        sheet.columns.map((c) => c.header),
        ...(sheet.rows.length === 0
          ? [["Nothing to show for this period."]]
          : sheet.rows.map((row) => row.map((value, index) => sheetValue(value, sheet.columns[index]?.kind ?? "text")))),
      ],
    })),
  ]
}

export async function fillReportSpreadsheet(
  created: CreatedSpreadsheet,
  accessToken: string,
  report: Report,
  fetchImpl: FetchLike = fetch
): Promise<GoogleResult<null>> {
  if (created[CREATED] !== true || !SPREADSHEET_ID.test(created.spreadsheetId)) {
    return { kind: "permanent_error", reason: "BizMind writes only to spreadsheets it created." }
  }
  const sent = await post(`${SHEETS}/${created.spreadsheetId}/values:batchUpdate`, accessToken, {
    valueInputOption: "RAW",
    data: reportValues(report),
  }, fetchImpl)
  return sent.kind === "ok" ? { kind: "ok", body: null } : sent
}

async function post(
  url: string,
  accessToken: string,
  body: unknown,
  fetchImpl: FetchLike
): Promise<GoogleResult<Record<string, unknown>>> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { kind: "retryable_error", reason: "Google did not respond in time." }
  }

  const text = await response.text().catch(() => "")
  if (!response.ok) return classifyGoogleError(response.status, text, response.headers.get("retry-after"))
  try {
    const parsed: unknown = text ? JSON.parse(text) : {}
    return { kind: "ok", body: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {} }
  } catch {
    return { kind: "retryable_error", reason: "Google's reply could not be read." }
  }
}
