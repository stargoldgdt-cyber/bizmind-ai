/**
 * The Google Sheets connector, without Google.
 *
 * Run with:  npm run test:google-sheets
 *
 * EVERY GOOGLE RESPONSE HERE IS A FIXTURE, AND SAYS SO.
 * `fakeGoogle()` answers the four endpoints the connector calls, shaped as
 * Google's documentation describes them. Nothing reaches a network, no real
 * token exists, and nothing here proves a real Google account works -- that
 * is the manual test once the owner's Google Cloud project is set up.
 *
 * What this DOES prove is everything BizMind decides on its own: which scope
 * is asked for, what counts as a row, that a number keeps its exact digits,
 * that a blank stays blank, when a pass ends, what each Google failure means,
 * and that the client secret and write endpoints are confined.
 */

process.env.BIZMIND_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com"
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret-not-real"
process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/v1/integrations/google/callback"

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { ExactNumber, isExactNumber, parseExactJson } from "../src/lib/json-exact"
import { getConnector, registeredProviders } from "../src/services/integrations"
import {
  createGoogleSheetsConnector,
  decodeCursor,
} from "../src/services/integrations/connectors/google-sheets"
import {
  classifyGoogleError,
  isSpreadsheetId,
  rowsRange,
} from "../src/services/integrations/connectors/google-sheets/client"
import {
  buildConsentUrl,
  exchangeCode,
  GOOGLE_SCOPE_DRIVE_FILE,
  googleOAuthConfig,
  refreshAccessToken,
  type FetchLike,
} from "../src/services/integrations/connectors/google-sheets/oauth"
import {
  openOAuthState,
  sealOAuthState,
} from "../src/services/integrations/connectors/google-sheets/state"
import {
  headingsFrom,
  recordsFrom,
} from "../src/services/integrations/connectors/google-sheets/table"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`)
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

/* -------------------------------------------------------------------------- */
/* The fixture: a pretend Google                                               */
/* -------------------------------------------------------------------------- */

const SHEET = "1BizMindFixtureSpreadsheet_0123456789-ab"

/** A cell that must go out as an UNQUOTED JSON number token, digits intact. */
class Raw {
  constructor(readonly token: string) {}
}

type FixtureCell = string | boolean | Raw | null

type Grid = {
  title: string
  sheetId: number
  /** Includes empty rows, as Google's gridProperties.rowCount does. */
  rowCount: number
  /** rows[0] is sheet row 1, the headings. */
  rows: FixtureCell[][]
}

/** JSON text in which Raw cells are written as bare number tokens. */
function toJsonText(value: unknown): string {
  if (value instanceof Raw) return value.token
  if (Array.isArray(value)) return `[${value.map(toJsonText).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}:${toJsonText(v)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

const isBlank = (cell: FixtureCell) => cell === null || cell === ""

function fakeGoogle(options: {
  grids: Grid[]
  version: () => string
  trashed?: boolean
  tokenStatus?: number
  tokenError?: string
}) {
  const calls = { token: 0, meta: 0, values: 0, drive: 0 }

  const respond = (status: number, body: unknown) =>
    new Response(toJsonText(body), { status, headers: { "Content-Type": "application/json" } })

  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(input)

    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
      calls.token += 1
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return respond(options.tokenStatus, { error: options.tokenError ?? "invalid_grant" })
      }
      return respond(200, { access_token: `fixture-access-${calls.token}`, expires_in: 3599 })
    }

    if (url.host === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")) {
      calls.drive += 1
      return respond(200, {
        id: SHEET,
        name: "Sales 2026",
        version: options.version(),
        modifiedTime: "2026-09-11T10:00:00Z",
        trashed: options.trashed ?? false,
      })
    }

    if (url.host === "sheets.googleapis.com" && url.pathname.endsWith("/values:batchGet")) {
      calls.values += 1
      const valueRanges = url.searchParams.getAll("ranges").map((range) => {
        const match = /^'((?:[^']|'')*)'!(\d+):(\d+)$/.exec(range)
        if (!match) return { range, values: [] }

        const title = match[1].replace(/''/g, "'")
        const first = Number.parseInt(match[2], 10)
        const last = Number.parseInt(match[3], 10)
        const grid = options.grids.find((g) => g.title === title)
        if (!grid) return { range, values: [] }

        // Google's own behaviour: trailing empty rows are omitted, and so are
        // trailing empty cells within a row. A blank row in the middle comes
        // back as [].
        const slice = grid.rows.slice(first - 1, last).map((row) => {
          const cells = [...row]
          while (cells.length > 0 && isBlank(cells[cells.length - 1])) cells.pop()
          return cells.map((cell) => (cell === null ? "" : cell))
        })
        while (slice.length > 0 && slice[slice.length - 1].length === 0) slice.pop()

        return slice.length > 0
          ? { range, majorDimension: "ROWS", values: slice }
          : { range, majorDimension: "ROWS" }
      })

      return respond(200, { spreadsheetId: SHEET, valueRanges })
    }

    if (url.host === "sheets.googleapis.com") {
      calls.meta += 1
      return respond(200, {
        spreadsheetId: SHEET,
        properties: { title: "Sales 2026" },
        sheets: options.grids.map((g) => ({
          properties: {
            sheetId: g.sheetId,
            title: g.title,
            gridProperties: { rowCount: g.rowCount, columnCount: 26 },
          },
        })),
      })
    }

    throw new Error(`The fixture was asked for something unexpected: ${input}`)
  }

  return { fetchImpl, calls }
}

/**
 * 2,500 orders on sheet rows 2..2501, in a tab whose grid has 2,600 rows.
 *
 *   - row 2 carries a total with more digits than a double can hold
 *   - every tenth order has no unit cost: blank, which must stay blank
 *   - rows 995..1010 are empty, straddling the 1,000-row page boundary
 */
function ordersGrid(title = "Orders"): Grid {
  const rows: FixtureCell[][] = [["Order ID", "Order date", "Order total", "Unit cost"]]

  for (let n = 1; n <= 2500; n += 1) {
    const sheetRow = n + 1
    if (sheetRow >= 995 && sheetRow <= 1010) {
      rows.push([])
      continue
    }
    rows.push([
      `ORD-${n}`,
      new Raw("46000"),
      new Raw(n === 1 ? "12345678901234567.89" : "100.25"),
      n % 10 === 0 ? "" : new Raw("60.10"),
    ])
  }

  return { title, sheetId: 7, rowCount: 2600, rows }
}

const ordersContext = (credentials: Record<string, string> = { refresh_token: "fixture-refresh" }) => ({
  externalAccountId: `${SHEET}:7`,
  credentials,
  metadata: { spreadsheet_id: SHEET, sheet_id: 7, entity: "ORDERS" },
})

const NOW = Date.parse("2026-09-11T12:00:00Z")

/* ========================================================================== */
section("1. A NUMBER KEEPS ITS EXACT DIGITS")
/* ========================================================================== */

const parsed = parseExactJson(
  '{"a":12345678901234567.89,"b":[1.10,"x",true,null],"c":{"d":-0.5e3}}'
) as { a: ExactNumber; b: [ExactNumber, string, boolean, null]; c: { d: ExactNumber } }

check("12345678901234567.89 survives exactly", isExactNumber(parsed.a) && parsed.a.text === "12345678901234567.89",
  String(parsed.a))
check("where JSON.parse would have printed 12345678901234568",
  String(JSON.parse('{"a":12345678901234567.89}').a) === "12345678901234568")
check("a trailing zero is kept: 1.10 stays 1.10", parsed.b[0].text === "1.10")
check("strings, booleans and null are untouched",
  parsed.b[1] === "x" && parsed.b[2] === true && parsed.b[3] === null)
check("exponent notation is kept as written", parsed.c.d.text === "-0.5e3")
check("an ExactNumber serialises as its text, never a double",
  JSON.stringify(new ExactNumber("1.10")) === '"1.10"')

let rejected = false
try {
  new ExactNumber("12abc")
} catch {
  rejected = true
}
check("something that is not a number cannot pose as one", rejected)

/* ========================================================================== */
section("2. SIGNING IN WITH GOOGLE")
/* ========================================================================== */

const config = googleOAuthConfig()
check("the server configuration is read from the environment", config !== null)

const consent = new URL(buildConsentUrl(config!, "state-nonce-123"))
check("EXACTLY ONE SCOPE IS REQUESTED: drive.file",
  consent.searchParams.get("scope") === GOOGLE_SCOPE_DRIVE_FILE,
  consent.searchParams.get("scope") ?? "")
check("offline access, so sync works while nobody is signed in",
  consent.searchParams.get("access_type") === "offline")
check("prompt=consent, because Google only returns a refresh token on the first consent",
  consent.searchParams.get("prompt") === "consent")
check("include_granted_scopes is NOT sent, so no other scope can ride along",
  !consent.searchParams.has("include_granted_scopes"))
check("the state is echoed for the callback to check",
  consent.searchParams.get("state") === "state-nonce-123")
check("the redirect URI is exactly the configured one",
  consent.searchParams.get("redirect_uri") === process.env.GOOGLE_REDIRECT_URI)
check("the client secret is never in a URL",
  !consent.toString().includes("test-client-secret-not-real"))

const savedSecret = process.env.GOOGLE_CLIENT_SECRET
delete process.env.GOOGLE_CLIENT_SECRET
check("without a client secret, Google is simply not configured", googleOAuthConfig() === null)
process.env.GOOGLE_CLIENT_SECRET = savedSecret

let exchangeRequest: { url: string; method?: string; body?: string } | null = null
const exchanged = await exchangeCode("auth-code", config!, async (input, init) => {
  exchangeRequest = { url: input, method: init?.method, body: String(init?.body ?? "") }
  return new Response(JSON.stringify({
    access_token: "a",
    refresh_token: "r",
    expires_in: 3599,
    scope: GOOGLE_SCOPE_DRIVE_FILE,
  }), { status: 200 })
})
check("a code is exchanged for a refresh token", exchanged.ok && exchanged.refreshToken === "r")
check("by POST, with the secret in the BODY and nothing in the query string",
  exchangeRequest !== null &&
    (exchangeRequest as { method?: string }).method === "POST" &&
    !(exchangeRequest as { url: string }).url.includes("?") &&
    ((exchangeRequest as { body?: string }).body ?? "").includes("client_secret=") &&
    ((exchangeRequest as { body?: string }).body ?? "").includes("grant_type=authorization_code"))

const reply = (status: number, body: unknown): FetchLike =>
  async () => new Response(JSON.stringify(body), { status })

const noRefresh = await exchangeCode("c", config!, reply(200, { access_token: "a", scope: GOOGLE_SCOPE_DRIVE_FILE }))
check("NO REFRESH TOKEN IS A FAILURE, not a connection that dies within the hour",
  !noRefresh.ok && noRefresh.reason === "missing_refresh_token")

const unticked = await exchangeCode("c", config!, reply(200, {
  access_token: "a", refresh_token: "r", scope: "openid",
}))
check("an owner who unticks the permission is told plainly",
  !unticked.ok && unticked.reason === "scope_not_granted")

const refused = await exchangeCode("c", config!, reply(400, { error: "invalid_grant" }))
check("a refused code is reported as refused", !refused.ok && refused.reason === "rejected")

const unreachable = await exchangeCode("c", config!, async () => {
  throw new Error("network down")
})
check("an unreachable Google is reported as unavailable",
  !unreachable.ok && unreachable.reason === "unavailable")

const refreshed = await refreshAccessToken("r", config!, reply(200, { access_token: "fresh", expires_in: 3599 }), () => NOW)
check("a refresh token mints an access token",
  refreshed.ok && refreshed.accessToken === "fresh")
check("which is treated as expiring a minute early",
  refreshed.ok && refreshed.expiresAt === NOW + 3599 * 1000 - 60_000)

const revoked = await refreshAccessToken("r", config!, reply(400, { error: "invalid_grant" }))
check("A REVOKED OR EXPIRED GRANT MEANS 'RECONNECT GOOGLE'",
  !revoked.ok && revoked.kind === "reauth")

const misconfigured = await refreshAccessToken("r", config!, reply(401, { error: "invalid_client" }))
check("a wrong client secret is the server's problem, not the owner's",
  !misconfigured.ok && misconfigured.kind === "misconfigured")

const busy = await refreshAccessToken("r", config!, reply(503, {}))
check("a Google outage is retried", !busy.ok && busy.kind === "retryable")

/* ========================================================================== */
section("3. WHAT EACH GOOGLE FAILURE MEANS")
/* ========================================================================== */

const c401 = classifyGoogleError(401, "{}", null)
check("401 -> reconnect Google", c401.kind === "permanent_error" && c401.code === "REAUTH_REQUIRED")

const c403rate = classifyGoogleError(403,
  JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }), null)
check("403 with a rate-limit reason is a RATE LIMIT, not a refusal",
  c403rate.kind === "rate_limited" && c403rate.retryAfterMs === 60_000)

const c403 = classifyGoogleError(403, JSON.stringify({ error: { status: "PERMISSION_DENIED" } }), null)
check("403 otherwise -> the sheet was unshared",
  c403.kind === "permanent_error" && c403.code === "ACCESS_DENIED")

const c404 = classifyGoogleError(404, "{}", null)
check("404 -> the spreadsheet is gone", c404.kind === "permanent_error" && c404.code === "SOURCE_GONE")

const c429 = classifyGoogleError(429, "{}", "12")
check("429 honours Retry-After", c429.kind === "rate_limited" && c429.retryAfterMs === 12_000)

const c429bare = classifyGoogleError(429, "{}", null)
check("and without it waits a full minute, when Google's quota refills",
  c429bare.kind === "rate_limited" && c429bare.retryAfterMs === 60_000)

check("5xx is retried with backoff", classifyGoogleError(503, "", null).kind === "retryable_error")
check("a 400 is ours to fix, and is not retried",
  classifyGoogleError(400, "{}", null).kind === "permanent_error")

check("a tab title with an apostrophe is quoted safely",
  rowsRange("It's sales", 2, 1001) === "'It''s sales'!2:1001")
check("a real spreadsheet id is accepted", isSpreadsheetId(SHEET))
check("a path is refused as a spreadsheet id", !isSpreadsheetId("../../etc/passwd"))
check("so is a URL", !isSpreadsheetId("https://evil.example/x"))

/* ========================================================================== */
section("4. ROWS, BY THE EXCEL IMPORTER'S RULES")
/* ========================================================================== */

check("headings are trimmed, and a blank heading stays blank",
  JSON.stringify(headingsFrom(["  Order ID ", "", new ExactNumber("2026"), true])) ===
    JSON.stringify(["Order ID", "", "2026", "true"]))

const shaped = recordsFrom(
  ["Order ID", "Total", "", "Total"],
  [
    ["ORD-1", new ExactNumber("10.00"), "ignored", new ExactNumber("99.50")],
    [],
    ["", "", "", ""],
    ["   ", ""],
    ["ORD-2", "", "", false],
  ],
  2
)

check("empty and whitespace-only rows are dropped", shaped.records.length === 2,
  String(shaped.records.length))
check("each record keeps the sheet row it came from", JSON.stringify(shaped.rowNumbers) === "[2,6]",
  JSON.stringify(shaped.rowNumbers))
check("a repeated heading: the LAST column wins, as in Excel",
  isExactNumber(shaped.records[0].Total) && (shaped.records[0].Total as ExactNumber).text === "99.50")
check("a column with a blank heading is ignored", !("" in shaped.records[0]))
check("A BLANK CELL IS ABSENT, NEVER AN EMPTY STRING OR A ZERO",
  shaped.records[1].Total === "false" && Object.keys(shaped.records[1]).length === 2,
  JSON.stringify(shaped.records[1]))

/* ========================================================================== */
section("5. THE CONNECTOR, OVER A 2,500-ROW TAB")
/* ========================================================================== */

let version = "10"
const google = fakeGoogle({ grids: [ordersGrid()], version: () => version })
const connector = createGoogleSheetsConnector({
  fetch: google.fetchImpl,
  config: googleOAuthConfig,
  pageRows: 1000,
  now: () => NOW,
})

const page1 = await connector.fetchPage({
  context: ordersContext(),
  resource: "ORDERS",
  mode: "INITIAL",
  cursor: null,
})

check("the first page is read", page1.kind === "page", page1.kind)

if (page1.kind === "page") {
  check("with the tab's headings", JSON.stringify(page1.table?.headers) ===
    JSON.stringify(["Order ID", "Order date", "Order total", "Unit cost"]))
  check("and 993 records -- rows 2..994, before the blank gap", page1.records.length === 993,
    String(page1.records.length))

  const first = page1.records[0]["Order total"]
  check("THE BIG TOTAL ARRIVES WITH EVERY DIGIT: 12345678901234567.89",
    isExactNumber(first) && first.text === "12345678901234567.89", String(first))

  const row11 = page1.records[page1.table!.rowNumbers.indexOf(11)]
  check("AN ORDER WITH NO UNIT COST HAS NO UNIT COST -- not zero",
    row11 !== undefined && !("Unit cost" in row11), JSON.stringify(row11))

  check("A BLANK GAP ACROSS THE PAGE BOUNDARY DOES NOT END THE PASS",
    page1.hasMore === true)
  check("the cursor carries the next row and the version the pass started at",
    JSON.stringify(decodeCursor(page1.nextCursor)) === JSON.stringify({ v: null, row: 1002, pv: "10" }),
    page1.nextCursor ?? "")
}

const page2 = page1.kind === "page"
  ? await connector.fetchPage({ context: ordersContext(), resource: "ORDERS", mode: "INITIAL", cursor: page1.nextCursor })
  : page1
const page3 = page2.kind === "page"
  ? await connector.fetchPage({ context: ordersContext(), resource: "ORDERS", mode: "INITIAL", cursor: page2.nextCursor })
  : page2

check("the page after the gap starts at the first real row, 1011",
  page2.kind === "page" && page2.table?.rowNumbers[0] === 1011,
  page2.kind === "page" ? String(page2.table?.rowNumbers[0]) : page2.kind)
check("the last page ends the pass", page3.kind === "page" && page3.hasMore === false)

const total = [page1, page2, page3].reduce(
  (sum, page) => sum + (page.kind === "page" ? page.records.length : 0), 0)
check("EVERY ONE OF THE 2,484 NON-BLANK ROWS WAS READ", total === 2484, String(total))
check("and the pass remembers the version it started at",
  page3.kind === "page" &&
    JSON.stringify(decodeCursor(page3.nextCursor)) === JSON.stringify({ v: "10", row: null, pv: null }))

check("ONE ACCESS TOKEN SERVED ALL THREE PAGES", google.calls.token === 1, String(google.calls.token))
check("and Drive was asked for the version once, at the start", google.calls.drive === 1,
  String(google.calls.drive))

/* ---- nothing changed ---------------------------------------------------- */
const valuesBefore = google.calls.values
const quiet = page3.kind === "page"
  ? await connector.fetchPage({ context: ordersContext(), resource: "ORDERS", mode: "INCREMENTAL", cursor: page3.nextCursor })
  : page3
check("AN UNCHANGED SHEET IS NOT READ AT ALL",
  quiet.kind === "page" && quiet.records.length === 0 && google.calls.values === valuesBefore,
  `${quiet.kind} values calls ${google.calls.values - valuesBefore}`)

/* ---- something changed --------------------------------------------------- */
version = "11"
const changed = quiet.kind === "page"
  ? await connector.fetchPage({ context: ordersContext(), resource: "ORDERS", mode: "INCREMENTAL", cursor: quiet.nextCursor })
  : quiet
check("a changed sheet is read again", changed.kind === "page" && changed.records.length > 0)

/* ---- renamed, deleted, binned, revoked ----------------------------------- */
const renamed = createGoogleSheetsConnector({
  fetch: fakeGoogle({ grids: [ordersGrid("Orders (renamed)")], version: () => "1" }).fetchImpl,
  config: googleOAuthConfig,
  now: () => NOW,
})
const afterRename = await renamed.fetchPage({ context: ordersContext(), resource: "ORDERS", mode: "INITIAL", cursor: null })
check("RENAMING THE TAB BREAKS NOTHING -- it is found by its id",
  afterRename.kind === "page" && afterRename.records.length > 0)

const deleted = createGoogleSheetsConnector({
  fetch: fakeGoogle({ grids: [{ ...ordersGrid(), sheetId: 99 }], version: () => "1" }).fetchImpl,
  config: googleOAuthConfig,
  now: () => NOW,
})
const afterDelete = await deleted.fetchPage({ context: ordersContext(), resource: "ORDERS", mode: "INITIAL", cursor: null })
check("a deleted tab is reported as gone",
  afterDelete.kind === "permanent_error" && afterDelete.code === "SOURCE_GONE")

const binned = createGoogleSheetsConnector({
  fetch: fakeGoogle({ grids: [ordersGrid()], version: () => "1", trashed: true }).fetchImpl,
  config: googleOAuthConfig,
  now: () => NOW,
})
const afterBin = await binned.fetchPage({ context: ordersContext(), resource: "ORDERS", mode: "INITIAL", cursor: null })
check("a spreadsheet moved to the bin is reported as gone",
  afterBin.kind === "permanent_error" && afterBin.code === "SOURCE_GONE")

const lapsed = createGoogleSheetsConnector({
  fetch: fakeGoogle({ grids: [ordersGrid()], version: () => "1", tokenStatus: 400 }).fetchImpl,
  config: googleOAuthConfig,
  now: () => NOW,
})
const afterLapse = await lapsed.fetchPage({ context: ordersContext(), resource: "ORDERS", mode: "INITIAL", cursor: null })
check("A LAPSED AUTHORISATION SAYS 'RECONNECT GOOGLE'",
  afterLapse.kind === "permanent_error" && afterLapse.code === "REAUTH_REQUIRED")

const headless = createGoogleSheetsConnector({
  fetch: fakeGoogle({
    grids: [{ title: "Orders", sheetId: 7, rowCount: 10, rows: [["", "", ""], ["ORD-1", "x", "y"]] }],
    version: () => "1",
  }).fetchImpl,
  config: googleOAuthConfig,
  now: () => NOW,
})
const afterHeadless = await headless.fetchPage({ context: ordersContext(), resource: "ORDERS", mode: "INITIAL", cursor: null })
check("a tab with no headings asks for a mapping review rather than guessing",
  afterHeadless.kind === "permanent_error" && afterHeadless.code === "MAPPING_REVIEW_REQUIRED")

const mismatch = await connector.fetchPage({ context: ordersContext(), resource: "PRODUCTS", mode: "INITIAL", cursor: null })
check("an orders tab cannot be synced as products", mismatch.kind === "permanent_error")

const badMeta = await connector.fetchPage({
  context: { ...ordersContext(), metadata: { spreadsheet_id: "../x", sheet_id: 7, entity: "ORDERS" } },
  resource: "ORDERS",
  mode: "INITIAL",
  cursor: null,
})
check("a connection with a bad spreadsheet id reads nothing", badMeta.kind === "permanent_error")

check("an unreadable cursor restarts the pass rather than skipping ahead",
  JSON.stringify(decodeCursor("{not json")) === JSON.stringify({ v: null, row: null, pv: null }))

/* ---- the browser's token, while connecting -------------------------------- */
const browserGoogle = fakeGoogle({ grids: [ordersGrid()], version: () => "1" })
const connecting = createGoogleSheetsConnector({
  fetch: browserGoogle.fetchImpl,
  config: googleOAuthConfig,
  now: () => NOW,
})
const validated = await connecting.validateConnection(ordersContext({ access_token: "browser-token-from-google" }))
check("WHILE CONNECTING, THE BROWSER'S OWN TOKEN IS USED",
  validated.ok && browserGoogle.calls.token === 0, String(browserGoogle.calls.token))
check("and the connection is named after the spreadsheet and tab",
  validated.ok && validated.displayName === "Sales 2026 — Orders",
  validated.ok ? validated.displayName : validated.reason)

check("the connector is registered", getConnector("GOOGLE_SHEETS") !== null &&
  registeredProviders().includes("GOOGLE_SHEETS"))

/* ========================================================================== */
section("6. CHANGE NOTIFICATIONS")
/* ========================================================================== */

const identified = connector.parseWebhook({
  headers: {
    "x-goog-channel-id": "channel-1",
    "x-goog-message-number": "5",
    "x-goog-resource-state": "update",
  },
  rawBody: "",
})
check("a notification is identified by its channel",
  identified.kind === "identified" &&
    identified.identity.externalAccountId === "channel-1" &&
    identified.identity.externalEventId === "channel-1:5" &&
    identified.identity.eventType === "drive.update")

check("one without a channel is not", connector.parseWebhook({ headers: {}, rawBody: "" }).kind === "unparseable")

const withToken = (token: string) => ({ "x-goog-channel-token": token })
check("the right token verifies", connector.verifyWebhook({ headers: withToken("s3cret"), rawBody: "", secret: "s3cret" }))
check("A WRONG TOKEN DOES NOT", !connector.verifyWebhook({ headers: withToken("s3creT"), rawBody: "", secret: "s3cret" }))
check("nor does a missing one", !connector.verifyWebhook({ headers: {}, rawBody: "", secret: "s3cret" }))
check("a notification carries no records to apply",
  connector.parseWebhookRecords({ eventType: "drive.update", rawBody: "" }) === null)

/* ========================================================================== */
section("7. THE SIGN-IN HANDSHAKE")
/* ========================================================================== */

const USER = "11111111-1111-4111-8111-111111111111"
const BUSINESS = "22222222-2222-4222-8222-222222222222"

const sealed = sealOAuthState({ nonce: "n-1", userId: USER, businessId: BUSINESS, now: NOW })
check("the state opens for the user and business that started it",
  openOAuthState(sealed, { userId: USER, businessId: BUSINESS, now: NOW }) === "n-1")
check("NOT FOR A DIFFERENT USER",
  openOAuthState(sealed, { userId: "33333333-3333-4333-8333-333333333333", businessId: BUSINESS, now: NOW }) === null)
check("NOT IF THE BUSINESS WAS SWITCHED MID-FLOW",
  openOAuthState(sealed, { userId: USER, businessId: "44444444-4444-4444-8444-444444444444", now: NOW }) === null)
check("not after ten minutes",
  openOAuthState(sealed, { userId: USER, businessId: BUSINESS, now: NOW + 11 * 60 * 1000 }) === null)

const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA")
check("not if it was tampered with",
  openOAuthState(tampered, { userId: USER, businessId: BUSINESS, now: NOW }) === null)

/* ========================================================================== */
section("8. WHAT IS CONFINED, AND WHERE")
/* ========================================================================== */

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full)
  }
  return out
}

const normalised = (file: string) => file.replace(/\\/g, "/")
const sources = walk("src")

const secretFiles = sources.filter((f) => readFileSync(f, "utf8").includes("GOOGLE_CLIENT_SECRET"))
check("THE GOOGLE CLIENT SECRET IS READ IN EXACTLY ONE FILE",
  secretFiles.length === 1 &&
    normalised(secretFiles[0]).endsWith("connectors/google-sheets/oauth.ts"),
  secretFiles.map(normalised).join(", "))

const clientSource = readFileSync("src/services/integrations/connectors/google-sheets/client.ts", "utf8")
const writeEndpoints = ["batchUpdate", ":append", ":clear", "values:update", '"PUT"', '"PATCH"', '"DELETE"', 'method: "POST"']
check("THE SHEETS CLIENT CANNOT WRITE: no write endpoint and no write method",
  writeEndpoints.every((w) => !clientSource.includes(w)),
  writeEndpoints.filter((w) => clientSource.includes(w)).join(", "))

const scopes = new Set(
  sources.flatMap((f) => readFileSync(f, "utf8").match(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/g) ?? [])
)
check("drive.file is the only Google scope anywhere in the code",
  scopes.size === 1 && scopes.has(GOOGLE_SCOPE_DRIVE_FILE), [...scopes].join(", "))

const connectorFiles = sources.filter((f) => normalised(f).includes("connectors/google-sheets/"))
check("the connector converts no figure to a floating-point number",
  connectorFiles.every((f) => {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    return !/parseFloat\(|[^.\w]Number\(/.test(code)
  }))

const actionsSource = readFileSync("src/features/integrations/google-actions.ts", "utf8")
check("CHOOSING A SHEET NEVER TOUCHES THE STORED AUTHORISATION",
  !actionsSource.includes("refresh_token") && !actionsSource.includes("credentials_encrypted") &&
    !actionsSource.includes("callTrusted"))

const callbackSource = readFileSync("src/app/api/v1/integrations/google/callback/route.ts", "utf8")
const loggedLines = callbackSource.split("\n").filter((line) => line.includes("console."))
check("the callback never logs a token",
  loggedLines.every((line) => !/refreshToken|accessToken|exchange\b/.test(line)),
  loggedLines.join(" | "))

/* ========================================================================== */

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
