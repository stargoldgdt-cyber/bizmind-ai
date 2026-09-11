import "server-only"

import { parseExactJson, type ExactNumber } from "@/lib/json-exact"

import type { FetchLike } from "./oauth"

/**
 * The Google Sheets and Drive transport. READ ONLY.
 *
 * `drive.file` technically lets BizMind edit a file the owner picked -- Google
 * has no per-file read-only scope. This module is where that permission is
 * never exercised: it issues GET requests and nothing else, and
 * `scripts/verify-google-sheets.mts` fails the build if a Sheets write
 * endpoint or a write method ever appears in it.
 *
 * NO USER-SUPPLIED URLS
 * ---------------------
 * Every request goes to one of two fixed Google hosts. The only user input in
 * a URL is a spreadsheet id, validated against Google's alphabet first, and a
 * tab title, quoted for A1 notation -- so there is no server-side request
 * forgery surface of the kind the WooCommerce client has to defend.
 *
 * EXACT NUMBERS
 * -------------
 * Cell values come back as JSON numbers. They are parsed by `parseExactJson`,
 * which keeps each number's exact text; `JSON.parse` would turn
 * 12345678901234567.89 into 12345678901234568 before any code could stop it.
 */

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files"
const TIMEOUT_MS = 30_000

/** Google's per-minute quotas refill each minute; waiting one is always safe. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000

export type GoogleFailure =
  | { kind: "rate_limited"; retryAfterMs: number; reason: string }
  | { kind: "retryable_error"; reason: string }
  | {
      kind: "permanent_error"
      code?: "REAUTH_REQUIRED" | "SOURCE_GONE" | "ACCESS_DENIED"
      reason: string
    }

export type GoogleResult<T> = { kind: "ok"; body: T } | GoogleFailure

/** A cell as Google returns it with UNFORMATTED_VALUE. */
export type SheetCell = string | boolean | ExactNumber | null | undefined

export type SheetTab = {
  /** Stable across renames. The identity of a tab. */
  sheetId: number
  /** Changes when someone renames the tab. Re-read on every sync. */
  title: string
  /** Includes empty rows -- a new sheet has 1,000. */
  rowCount: number
  columnCount: number
}

export type SpreadsheetMeta = {
  spreadsheetId: string
  title: string
  tabs: SheetTab[]
}

export type DriveFileMeta = {
  id: string
  name: string
  /** Increases on every change to the file, including cell edits. */
  version: string
  modifiedTime: string | null
  trashed: boolean
}

/** Google spreadsheet ids use a URL-safe alphabet. Anything else is refused. */
export function isSpreadsheetId(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,200}$/.test(value)
}

/**
 * A1 notation for whole rows of one tab, e.g. `'Orders 2026'!2:1001`.
 *
 * Titles are always quoted, with embedded apostrophes doubled -- a tab called
 * "It's sales" must not end the quoted string early.
 */
export function rowsRange(title: string, firstRow: number, lastRow: number): string {
  return `'${title.replace(/'/g, "''")}'!${firstRow}:${lastRow}`
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** The spreadsheet's name and its tabs. */
export async function getSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  fetchImpl: FetchLike
): Promise<GoogleResult<SpreadsheetMeta>> {
  if (!isSpreadsheetId(spreadsheetId)) {
    return { kind: "permanent_error", reason: "That is not a valid spreadsheet." }
  }

  const fields =
    "spreadsheetId,properties.title," +
    "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))"

  const response = await get(
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`,
    accessToken,
    fetchImpl
  )
  if (!response.ok) return response.failure

  const body = parsePlain(response.text)
  const properties = asObject(body?.properties)
  const sheets = Array.isArray(body?.sheets) ? body.sheets : null

  if (!body || !properties || !sheets) {
    return { kind: "retryable_error", reason: "Google returned an unexpected spreadsheet." }
  }

  const tabs: SheetTab[] = []
  for (const sheet of sheets) {
    const p = asObject(asObject(sheet)?.properties)
    const grid = asObject(p?.gridProperties)
    if (!p || typeof p.sheetId !== "number" || typeof p.title !== "string") continue

    tabs.push({
      sheetId: p.sheetId,
      title: p.title,
      rowCount: typeof grid?.rowCount === "number" ? grid.rowCount : 0,
      columnCount: typeof grid?.columnCount === "number" ? grid.columnCount : 0,
    })
  }

  return {
    kind: "ok",
    body: {
      spreadsheetId,
      title: typeof properties.title === "string" ? properties.title : "Untitled spreadsheet",
      tabs,
    },
  }
}

/**
 * The values of several ranges in ONE request, which Google counts as one
 * read against the 60-per-minute-per-user quota.
 *
 * Returns one grid per range requested, in order. Google omits trailing empty
 * rows and trailing empty cells, so a grid may be shorter than asked for.
 */
export async function getValues(
  accessToken: string,
  spreadsheetId: string,
  ranges: string[],
  fetchImpl: FetchLike
): Promise<GoogleResult<SheetCell[][][]>> {
  if (!isSpreadsheetId(spreadsheetId)) {
    return { kind: "permanent_error", reason: "That is not a valid spreadsheet." }
  }

  const query = [
    ...ranges.map((range) => `ranges=${encodeURIComponent(range)}`),
    "valueRenderOption=UNFORMATTED_VALUE",
    "dateTimeRenderOption=SERIAL_NUMBER",
    "majorDimension=ROWS",
  ].join("&")

  const response = await get(
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${query}`,
    accessToken,
    fetchImpl
  )
  if (!response.ok) return response.failure

  let body: unknown
  try {
    body = parseExactJson(response.text)
  } catch {
    return { kind: "retryable_error", reason: "Google returned values BizMind could not read." }
  }

  const valueRanges = asObject(body)?.valueRanges
  if (!Array.isArray(valueRanges)) {
    return { kind: "retryable_error", reason: "Google returned an unexpected value range." }
  }

  return {
    kind: "ok",
    body: valueRanges.map((range) => {
      const values = asObject(range)?.values
      return Array.isArray(values)
        ? values.map((row) => (Array.isArray(row) ? (row as SheetCell[]) : []))
        : []
    }),
  }
}

/** The file's Drive version and whether it is in the bin. One small call. */
export async function getDriveFile(
  accessToken: string,
  fileId: string,
  fetchImpl: FetchLike
): Promise<GoogleResult<DriveFileMeta>> {
  if (!isSpreadsheetId(fileId)) {
    return { kind: "permanent_error", reason: "That is not a valid spreadsheet." }
  }

  const response = await get(
    `${DRIVE_FILES}/${encodeURIComponent(fileId)}` +
      "?fields=id,name,version,modifiedTime,trashed&supportsAllDrives=true",
    accessToken,
    fetchImpl
  )
  if (!response.ok) return response.failure

  const body = parsePlain(response.text)
  if (!body || typeof body.version !== "string") {
    return { kind: "retryable_error", reason: "Google returned an unexpected file." }
  }

  return {
    kind: "ok",
    body: {
      id: typeof body.id === "string" ? body.id : fileId,
      name: typeof body.name === "string" ? body.name : "",
      version: body.version,
      modifiedTime: typeof body.modifiedTime === "string" ? body.modifiedTime : null,
      trashed: body.trashed === true,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Transport and classification                                                */
/* -------------------------------------------------------------------------- */

async function get(
  url: string,
  accessToken: string,
  fetchImpl: FetchLike
): Promise<{ ok: true; text: string } | { ok: false; failure: GoogleFailure }> {
  let response: Response

  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return {
      ok: false,
      failure: { kind: "retryable_error", reason: "Google did not respond in time." },
    }
  }

  const text = await response.text().catch(() => "")

  if (response.ok) return { ok: true, text }

  return {
    ok: false,
    failure: classifyGoogleError(response.status, text, response.headers.get("retry-after")),
  }
}

/**
 * What a failed Google response means for the engine.
 *
 * Exported so the tests can hold every branch to account. The distinctions
 * matter: a rate limit refunds the attempt, a 5xx retries with backoff, and a
 * revoked token goes straight to "reconnect Google" rather than burning seven
 * attempts discovering that nothing has changed.
 */
export function classifyGoogleError(
  status: number,
  body: string,
  retryAfter: string | null
): GoogleFailure {
  const reason = googleErrorReason(body)

  const rateLimited =
    status === 429 ||
    (status === 403 && /rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED/i.test(reason))

  if (rateLimited) {
    const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim())
      ? Number.parseInt(retryAfter.trim(), 10)
      : null

    return {
      kind: "rate_limited",
      retryAfterMs: seconds !== null ? seconds * 1000 : DEFAULT_RATE_LIMIT_WAIT_MS,
      reason: "Google asked BizMind to slow down.",
    }
  }

  if (status === 401) {
    return {
      kind: "permanent_error",
      code: "REAUTH_REQUIRED",
      reason: "Google access has expired or was revoked. Reconnect Google to resume syncing.",
    }
  }

  if (status === 403) {
    return {
      kind: "permanent_error",
      code: "ACCESS_DENIED",
      reason:
        "BizMind can no longer open this spreadsheet. It may have been unshared, " +
        "or opened with a different Google account.",
    }
  }

  if (status === 404) {
    return {
      kind: "permanent_error",
      code: "SOURCE_GONE",
      reason: "This spreadsheet no longer exists, or BizMind can no longer see it.",
    }
  }

  if (status === 408 || status >= 500) {
    return { kind: "retryable_error", reason: `Google returned ${status}. It will be retried.` }
  }

  return { kind: "permanent_error", reason: `Google refused the request (${status}).` }
}

/** Google's machine-readable error reason, from either of its error shapes. */
function googleErrorReason(body: string): string {
  const parsed = parsePlain(body)
  const error = asObject(parsed?.error)
  if (!error) return ""

  const errors = Array.isArray(error.errors) ? error.errors : []
  const first = asObject(errors[0])
  const details = Array.isArray(error.details) ? error.details : []
  const detail = asObject(details[0])

  return [
    typeof first?.reason === "string" ? first.reason : "",
    typeof detail?.reason === "string" ? detail.reason : "",
    typeof error.status === "string" ? error.status : "",
  ].join(" ")
}

/** Plain JSON, for metadata only -- never for cell values. */
function parsePlain(text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text))
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
