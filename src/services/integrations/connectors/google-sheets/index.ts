import "server-only"

import { createHash, randomUUID } from "node:crypto"

import { signaturesMatch } from "@/lib/crypto"
import type { RawRecord } from "@/services/ingestion/contracts"
import { normalizeText } from "@/services/ingestion/normalize"
import type {
  Connector,
  ConnectorContext,
  FetchResult,
  WebhookParseResult,
} from "@/services/integrations/contract"

import { getDriveFile, getSpreadsheet, getValues, isSpreadsheetId, rowsRange } from "./client"
import { googleOAuthConfig, refreshAccessToken, type FetchLike, type GoogleOAuthConfig } from "./oauth"
import { headingsFrom, recordsFrom } from "./table"

/**
 * The Google Sheets connector.
 *
 * One connection is one TAB of one spreadsheet, holding one kind of record:
 * orders, products or expenses. Its identity is `spreadsheetId:sheetId` -- the
 * tab's numeric id, which survives renames. The title is re-read on every
 * sync, so renaming a tab breaks nothing.
 *
 * WHAT IT RETURNS
 * ---------------
 * Table-shaped pages: records keyed by the sheet's own headings, plus the row
 * each came from. It does NOT map, validate or normalise -- the worker applies
 * the owner's confirmed mapping through the same `validate()` the CSV importer
 * uses. There is one mapping engine, not one per source.
 *
 * HOW A PASS WORKS
 * ----------------
 *   1. Ask Drive for the file's `version`, one small call. If this is an
 *      incremental sync and the version matches the last completed pass,
 *      stop: nothing changed, and no rows are read.
 *   2. Otherwise read the tab a page at a time: the heading row and one block
 *      of rows, in a single request.
 *   3. When the pass finishes, remember the version it STARTED at. An edit
 *      made while it was running therefore still counts as a change next time.
 *   4. An orders tab is never cut inside an order: a page that would end
 *      part-way through one stops before it, and the next page starts on it.
 *
 * "More pages?" is decided by the tab's row count, not by a short page.
 * Google omits trailing empty rows, so a block of blank rows spanning a page
 * boundary returns a short page with data still below it; ending there would
 * silently drop every row after the gap.
 *
 * WHAT IT MAY NOT DO
 * ------------------
 * The rules of `contract.ts`: no writes, no arithmetic on money, no tenant
 * decisions, no retries. A failure is reported; the engine decides.
 */

export const GOOGLE_PAGE_ROWS = 1000

const ENTITIES = ["ORDERS", "PRODUCTS", "EXPENSES"] as const
type Entity = (typeof ENTITIES)[number]

type SheetsMetadata = {
  spreadsheetId: string
  sheetId: number
  entity: Entity
  /** The heading holding the order ID, so a page never ends inside an order. */
  groupColumn: string | null
}

/**
 * The connector's private checkpoint. The engine stores and replays it
 * without reading it.
 *
 *   v   the Drive version of the last COMPLETED pass
 *   row the next row to read, while a pass is under way
 *   pv  the version the current pass started at
 *   pid the current pass's id: random, the same on every page of one pass
 */
export type SheetsCursor = {
  v: string | null
  row: number | null
  pv: string | null
  pid: string | null
}

const EMPTY_CURSOR: SheetsCursor = { v: null, row: null, pv: null, pid: null }

export function decodeCursor(raw: string | null): SheetsCursor {
  if (!raw) return EMPTY_CURSOR

  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object") return EMPTY_CURSOR
    const c = parsed as Record<string, unknown>

    const cursor: SheetsCursor = {
      v: typeof c.v === "string" ? c.v : null,
      row: typeof c.row === "number" && Number.isInteger(c.row) && c.row >= 2 ? c.row : null,
      pv: typeof c.pv === "string" ? c.pv : null,
      pid: typeof c.pid === "string" && c.pid.length > 0 && c.pid.length <= 64 ? c.pid : null,
    }

    // A pass under way without its id cannot say which records it has already
    // seen, so it starts again from the top. Re-reading is harmless; a wrong
    // "no longer in the sheet" report is not.
    if (cursor.row !== null && cursor.pid === null) return { ...EMPTY_CURSOR, v: cursor.v }

    return cursor
  } catch {
    // An unreadable cursor restarts the pass. Reading a page twice is harmless
    // -- writes are idempotent -- whereas skipping one is not.
    return EMPTY_CURSOR
  }
}

function readMetadata(metadata: Record<string, unknown>): SheetsMetadata | null {
  const spreadsheetId = typeof metadata.spreadsheet_id === "string" ? metadata.spreadsheet_id : ""
  const sheetId = metadata.sheet_id
  const entity = ENTITIES.find((e) => e === metadata.entity)

  if (!isSpreadsheetId(spreadsheetId)) return null
  if (typeof sheetId !== "number" || !Number.isInteger(sheetId) || sheetId < 0) return null
  if (!entity) return null

  // Only an orders tab groups rows: the lines of one order share its ID.
  const mapping = metadata.mapping
  const orderIdColumn =
    entity === "ORDERS" && mapping !== null && typeof mapping === "object"
      ? (mapping as Record<string, unknown>).external_id
      : undefined
  const groupColumn =
    typeof orderIdColumn === "string" && orderIdColumn.trim() !== "" ? orderIdColumn : null

  return { spreadsheetId, sheetId, entity, groupColumn }
}

/**
 * Where the last run of rows sharing one order ID begins, so it can be held
 * back for the next page.
 *
 * Returns `records.length` -- hold nothing back -- when the last row has no ID,
 * or when the whole page is one order: holding that back would never make
 * progress. The worker then reports the order as split rather than writing
 * half of it.
 */
function trailingGroupStart(records: readonly RawRecord[], column: string): number {
  const last = records.length - 1
  if (last < 0) return records.length

  const key = normalizeText(records[last][column])
  if (key === null) return records.length

  let start = last
  while (start > 0 && normalizeText(records[start - 1][column]) === key) start -= 1

  return start === 0 ? records.length : start
}

type Dependencies = {
  /** Injected so tests never reach Google. Defaults to the real `fetch`. */
  fetch?: FetchLike
  config?: () => GoogleOAuthConfig | null
  pageRows?: number
  now?: () => number
}

export function createGoogleSheetsConnector(deps: Dependencies = {}): Connector {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))
  const config = deps.config ?? googleOAuthConfig
  const pageRows = deps.pageRows ?? GOOGLE_PAGE_ROWS
  const now = deps.now ?? Date.now

  /**
   * Access tokens last about an hour, so one is reused across pages rather
   * than minted per request. Keyed by a HASH of the refresh token, so the
   * cache never holds a second copy of the secret itself.
   */
  const tokenCache = new Map<string, { token: string; expiresAt: number }>()

  async function accessTokenFor(
    context: ConnectorContext
  ): Promise<{ ok: true; token: string } | { ok: false; failure: FetchResult }> {
    // While connecting, the browser's own short-lived token is used: the
    // stored authorisation never serves a person's request.
    const direct = context.credentials.access_token
    if (direct) return { ok: true, token: direct }

    const refreshToken = context.credentials.refresh_token
    if (!refreshToken) {
      return {
        ok: false,
        failure: {
          kind: "permanent_error",
          code: "REAUTH_REQUIRED",
          reason: "No Google authorisation is stored for this business. Reconnect Google.",
        },
      }
    }

    const key = createHash("sha256").update(refreshToken).digest("hex")
    const cached = tokenCache.get(key)
    if (cached && cached.expiresAt > now()) return { ok: true, token: cached.token }

    const cfg = config()
    if (!cfg) {
      return {
        ok: false,
        failure: { kind: "permanent_error", reason: "Google is not configured on this server." },
      }
    }

    const refreshed = await refreshAccessToken(refreshToken, cfg, fetchImpl, now)

    if (!refreshed.ok) {
      if (refreshed.kind === "reauth") {
        return {
          ok: false,
          failure: { kind: "permanent_error", code: "REAUTH_REQUIRED", reason: refreshed.message },
        }
      }
      if (refreshed.kind === "misconfigured") {
        return { ok: false, failure: { kind: "permanent_error", reason: refreshed.message } }
      }
      return { ok: false, failure: { kind: "retryable_error", reason: refreshed.message } }
    }

    tokenCache.set(key, { token: refreshed.accessToken, expiresAt: refreshed.expiresAt })
    return { ok: true, token: refreshed.accessToken }
  }

  return {
    provider: "GOOGLE_SHEETS",

    // Not used for Google Sheets: the owner chooses a sales channel per ORDERS
    // tab, and products and expenses tabs have none.
    channelType: "OTHER",

    resources: ENTITIES,

    async validateConnection(context) {
      const meta = readMetadata(context.metadata)
      if (!meta) return { ok: false, reason: "Choose a spreadsheet, a tab, and what it holds." }

      const auth = await accessTokenFor(context)
      if (!auth.ok) {
        return { ok: false, reason: "reason" in auth.failure ? auth.failure.reason : "Google refused." }
      }

      const sheet = await getSpreadsheet(auth.token, meta.spreadsheetId, fetchImpl)
      if (sheet.kind !== "ok") return { ok: false, reason: sheet.reason }

      const tab = sheet.body.tabs.find((t) => t.sheetId === meta.sheetId)
      if (!tab) return { ok: false, reason: "That tab no longer exists in the spreadsheet." }

      return {
        ok: true,
        displayName: `${sheet.body.title} — ${tab.title}`,
        metadata: {
          ...context.metadata,
          spreadsheet_name: sheet.body.title,
          sheet_title: tab.title,
        },
      }
    },

    async fetchPage({ context, resource, mode, cursor }): Promise<FetchResult> {
      const meta = readMetadata(context.metadata)
      if (!meta) {
        return {
          kind: "permanent_error",
          reason: "This connection is missing its spreadsheet details. Reconnect the sheet.",
        }
      }

      if (resource !== meta.entity) {
        return {
          kind: "permanent_error",
          reason: `This tab holds ${meta.entity.toLowerCase()}, not ${resource.toLowerCase()}.`,
        }
      }

      const auth = await accessTokenFor(context)
      if (!auth.ok) return auth.failure

      const position = decodeCursor(cursor)
      let passVersion = position.pv
      let passId = position.pid
      let firstRow = position.row ?? 2

      // A new pass: has anything changed since the last one finished?
      if (position.row === null) {
        const file = await getDriveFile(auth.token, meta.spreadsheetId, fetchImpl)
        if (file.kind !== "ok") return file

        if (file.body.trashed) {
          return {
            kind: "permanent_error",
            code: "SOURCE_GONE",
            reason: "This spreadsheet has been moved to the bin in Google Drive.",
          }
        }

        if (mode === "INCREMENTAL" && position.v !== null && file.body.version === position.v) {
          return { kind: "page", records: [], nextCursor: JSON.stringify(position), hasMore: false }
        }

        passVersion = file.body.version
        passId = randomUUID()
        firstRow = 2
      }

      // Re-read every time: the tab's title is how A1 ranges name it, and a
      // rename must not break the connection.
      const sheet = await getSpreadsheet(auth.token, meta.spreadsheetId, fetchImpl)
      if (sheet.kind !== "ok") return sheet

      const tab = sheet.body.tabs.find((t) => t.sheetId === meta.sheetId)
      if (!tab) {
        return {
          kind: "permanent_error",
          code: "SOURCE_GONE",
          reason: "The tab this connection reads has been deleted from the spreadsheet.",
        }
      }

      const lastRow = firstRow + pageRows - 1

      const values = await getValues(
        auth.token,
        meta.spreadsheetId,
        [rowsRange(tab.title, 1, 1), rowsRange(tab.title, firstRow, lastRow)],
        fetchImpl
      )
      if (values.kind !== "ok") return values

      const headers = headingsFrom(values.body[0]?.[0] ?? [])

      if (headers.every((heading) => heading === "")) {
        return {
          kind: "permanent_error",
          code: "MAPPING_REVIEW_REQUIRED",
          reason:
            "The first row of this tab has no column headings. BizMind needs them " +
            "to know what each column holds.",
        }
      }

      const read = recordsFrom(headers, values.body[1] ?? [], firstRow)
      let records = read.records
      let rowNumbers = read.rowNumbers
      let nextRow = lastRow + 1
      const hasMore = lastRow < tab.rowCount

      // The rows of one order usually sit together. If this page ends in the
      // middle of an order, the rest of its lines are on the next page -- and
      // applying an order REPLACES its lines, so the next page would silently
      // drop the ones read here. Hold that last order back and start the next
      // page on its first row, so every order arrives whole.
      if (hasMore && meta.groupColumn) {
        const cut = trailingGroupStart(records, meta.groupColumn)
        if (cut < records.length) {
          nextRow = rowNumbers[cut]
          records = records.slice(0, cut)
          rowNumbers = rowNumbers.slice(0, cut)
        }
      }

      const next: SheetsCursor = hasMore
        ? { v: position.v, row: nextRow, pv: passVersion, pid: passId }
        : { v: passVersion, row: null, pv: null, pid: null }

      return {
        kind: "page",
        records,
        nextCursor: JSON.stringify(next),
        hasMore,
        table: {
          headers: headers.filter((heading) => heading !== ""),
          rowNumbers,
          passId: passId ?? undefined,
        },
      }
    },

    /**
     * A Drive change notification: identity from the channel headers.
     *
     * Untrusted until the channel is found in integration_watch_channels and
     * its token verified. The body is always empty -- Google sends headers
     * only -- so there is nothing else to read.
     */
    parseWebhook({ headers }): WebhookParseResult {
      const channelId = headers["x-goog-channel-id"]?.trim()
      const message = headers["x-goog-message-number"]?.trim() ?? ""
      const state = headers["x-goog-resource-state"]?.trim() ?? "unknown"

      if (!channelId) {
        return { kind: "unparseable", reason: "No X-Goog-Channel-ID header." }
      }

      return {
        kind: "identified",
        identity: {
          externalAccountId: channelId,
          externalEventId: `${channelId}:${message}`,
          eventType: `drive.${state}`,
        },
      }
    },

    /**
     * Google does not sign notifications. Their authenticity is the secret
     * token BizMind set when creating the channel, which Google echoes in
     * X-Goog-Channel-Token -- compared in constant time.
     */
    verifyWebhook({ headers, secret }) {
      const provided = headers["x-goog-channel-token"] ?? ""
      if (secret === "" || provided === "") return false
      return signaturesMatch(secret, provided)
    },

    /** A notification is a signal to sync, not data. There is nothing to apply. */
    parseWebhookRecords() {
      return null
    },
  }
}

export const googleSheetsConnector = createGoogleSheetsConnector()
