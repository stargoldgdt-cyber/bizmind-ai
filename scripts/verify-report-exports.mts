/**
 * Report exports to Google Sheets: the WRITE-SCOPE test, offline (GCC Phase 8).
 *
 * Run with:  npm run test:report-exports   (part of npm run verify)
 *
 * Decision A5: BizMind writes only to spreadsheets it created for an export.
 * Proves, with a fake Google and by reading the source:
 *   - an export creates a NEW spreadsheet, then writes only to that one
 *   - no code path takes a spreadsheet id from anywhere else
 *   - values are written RAW (never evaluated), exactly, blanks left blank
 *   - the sync connector stays read-only, and only one module can write
 *   - the worker functions are worker-only and take an export id, never a business id
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { aboutLines, payoutSheets, type Report } from "../src/services/reports/catalog"
import {
  createReportSpreadsheet,
  fillReportSpreadsheet,
  reportValues,
  type CreatedSpreadsheet,
} from "../src/services/reports/google-sheets-export"
import type { Database } from "../src/types/database"

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

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")
const norm = (path: string) => path.replace(/\\/g, "/")

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

type Fn = Database["public"]["Functions"]
const payout = {
  payout_key: "00000000-0000-0000-0000-000000000009", source: "SETTLEMENT_REPORT",
  marketplace_account_id: "00000000-0000-0000-0000-000000000001", account_label: "=IMPORTXML(\"x\")",
  marketplace_code: "AMAZON", currency: "AED", reference: "INVENTED", source_file_id: null, file_name: null,
  period_start: null, period_end: null, expected_date: "2026-07-18T00:00:00Z", expected_amount: "1234567890123.4567",
  settlement_lines_total: null, settlement_lines: 1, marketplace_status: "NO_TOTAL", bank_receipt_status: "NOT_CONNECTED",
  bank_receipt_amount: null, bank_receipt_date: null,
} satisfies Fn["expected_payouts"]["Returns"][number]

const report: Report = {
  key: "payouts",
  title: "Expected payouts and cashflow",
  about: aboutLines({ businessName: "Invented", period: "July 2026", generatedAt: "now" }),
  sheets: payoutSheets([payout, { ...payout, expected_amount: null, account_label: "Amazon.ae" }], []),
}

/* -------------------------------------------------------------------------- */
section("1. CREATE, THEN WRITE ONLY THERE (a fake Google)")

const NEW_ID = "NEWSHEET_created_by_bizmind_0123456789"
const calls: { url: string; method: string; body: Record<string, unknown> }[] = []
const fakeGoogle = async (url: string, init?: RequestInit) => {
  calls.push({ url, method: String(init?.method), body: JSON.parse(String(init?.body ?? "{}")) })
  if (url === "https://sheets.googleapis.com/v4/spreadsheets") {
    return new Response(JSON.stringify({ spreadsheetId: NEW_ID, spreadsheetUrl: "https://evil.example/elsewhere" }), { status: 200 })
  }
  return new Response("{}", { status: 200 })
}

const created = await createReportSpreadsheet("token", report, "BizMind — Expected payouts", fakeGoogle)
check("a new spreadsheet is created with an About tab and the report's tabs",
  created.kind === "ok" && calls[0]?.method === "POST" &&
    JSON.stringify((calls[0]?.body.sheets as { properties: { title: string } }[]).map((s) => s.properties.title)) ===
      JSON.stringify(["About", "Expected payouts", "Expected cashflow"]),
  JSON.stringify(calls[0]))
check("its link is built by BizMind from the new id, not taken from Google's reply",
  created.kind === "ok" && created.body.spreadsheetUrl === `https://docs.google.com/spreadsheets/d/${NEW_ID}/edit`)

if (created.kind === "ok") {
  const filled = await fillReportSpreadsheet(created.body, "token", report, fakeGoogle)
  check("the values go to that new spreadsheet, and nowhere else",
    filled.kind === "ok" && calls.length === 2 &&
      calls[1].url === `https://sheets.googleapis.com/v4/spreadsheets/${NEW_ID}/values:batchUpdate`,
    JSON.stringify(calls.map((c) => c.url)))
  check("written RAW: Google stores values as given and never evaluates a formula", calls[1].body.valueInputOption === "RAW")
}

const forged = { spreadsheetId: "OWNERS_existing_sheet_0123456789", spreadsheetUrl: "x", sheetTitles: [] } as unknown as CreatedSpreadsheet
const refused = await fillReportSpreadsheet(forged, "token", report, fakeGoogle)
check("a spreadsheet BizMind did not create is refused, and nothing is sent",
  refused.kind === "permanent_error" && calls.length === 2, JSON.stringify(refused))

const badReply = async () => new Response(JSON.stringify({ spreadsheetId: "../../drive/files" }), { status: 200 })
const bad = await createReportSpreadsheet("token", report, "x", badReply)
check("a reply without a proper new id is not used", bad.kind === "retryable_error")

const denied = async () => new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED" } }), { status: 403 })
check("Google refusing is reported, not retried forever", (await createReportSpreadsheet("token", report, "x", denied)).kind !== "ok")

/* -------------------------------------------------------------------------- */
section("2. THE VALUES")

const values = reportValues(report)
const payoutsRange = values.find((v) => v.range === "'Expected payouts'!A1")
check("each tab is addressed by its own quoted name", !!payoutsRange && values[0].range === "'About'!A1")
check("a 17-digit figure is sent as exact text", payoutsRange?.values[1]?.[6] === "1234567890123.4567", JSON.stringify(payoutsRange?.values[1]))
check("a missing figure is an empty cell, never zero", payoutsRange?.values[2]?.[6] === "")
check("a formula-looking name is sent as plain text (RAW keeps it text)", payoutsRange?.values[1]?.[0] === "=IMPORTXML(\"x\")")
check("the bank column reads Not connected", payoutsRange?.values[1]?.[9] === "Not connected")
check("an empty tab says so", JSON.stringify(values.find((v) => v.range === "'Expected cashflow'!A1")?.values[1]) ===
  JSON.stringify(["Nothing to show for this period."]))

/* -------------------------------------------------------------------------- */
section("3. ONLY ONE MODULE CAN WRITE")

const WRITER = "src/services/reports/google-sheets-export.ts"
const writeMarkers = ["values:batchUpdate", ":append", ":clear", "values:update", "spreadsheets.batchUpdate"]
const writers = walk("src").filter((file) => writeMarkers.some((m) => read(file).includes(m))).map(norm)
check("the Sheets write endpoint appears in exactly one file", JSON.stringify(writers) === JSON.stringify([WRITER]), writers.join(", "))
const writerSource = read(WRITER)
check("that file offers no way to write to a spreadsheet by id",
  !/export (async )?function \w+\([^)]*spreadsheetId\s*:\s*string/.test(writerSource) &&
    writerSource.includes("created: CreatedSpreadsheet"))
check("the sync connector's client is still read-only",
  !read("src/services/integrations/connectors/google-sheets/client.ts").includes('method: "POST"'))
const importers = walk("src").filter((file) => read(file).includes("reports/google-sheets-export")).map(norm)
check("only the export worker uses the writer",
  JSON.stringify(importers) === JSON.stringify(["src/services/integrations/sync/report-exports.ts"]), importers.join(", "))
const RUNNER = read("src/services/integrations/sync/report-exports.ts")
check("the worker records the new spreadsheet before writing into it",
  RUNNER.indexOf('"report_export_attach"') > 0 && RUNNER.indexOf('"report_export_attach"') < RUNNER.indexOf("fillReportSpreadsheet(created.body"))
check("the sync worker never imports the writer", !read("src/services/integrations/sync/worker.ts").includes("google-sheets-export"))

/* -------------------------------------------------------------------------- */
section("4. THE DATABASE SIDE (migration 0040)")

const MIGRATION = read("supabase/migrations/0040_report_exports_sheets.sql")
const PRIVILEGED = read("src/services/integrations/security/privileged.ts")
for (const fn of ["report_export_claim", "report_export_data", "report_export_attach", "report_export_complete"]) {
  check(`${fn} is on the trusted list and granted to the worker only`,
    PRIVILEGED.includes(`"${fn}",`) && MIGRATION.includes(`'public.${fn}(`))
}
check("the request function is not on the trusted list", !PRIVILEGED.includes('"report_export_request"'))
check("the request takes no spreadsheet", !/create function public\.report_export_request\([^)]*spreadsheet/.test(MIGRATION))
check("an attached spreadsheet can never change", MIGRATION.includes("An export''s spreadsheet cannot be changed."))
check("the link must be the created spreadsheet's own",
  MIGRATION.includes("'https://docs.google.com/spreadsheets/d/' || p_spreadsheet_id || '/edit'"))
check("a retry never creates a second spreadsheet",
  MIGRATION.includes("when p_status = 'RETRY' and v_export.attempts < 3 and v_export.spreadsheet_id is null then 'QUEUED'"))
check("only an owner or admin may ask, with Google connected",
  MIGRATION.includes("Only an owner or admin can export to Google Sheets.") && MIGRATION.includes("Connect Google first"))
check("the figures come from the same readers as the screens",
  ["pnl_summary(", "pnl_by_product(", "pnl_net_profit(", "expense_breakdown(", "expected_payouts(", "expected_cashflow(", "ledger_data_quality("]
    .every((reader) => MIGRATION.includes(`public.${reader}`)))
check("the action uses the person's session and never passes a business id to the worker",
  read("src/features/reports/actions.ts").includes('rpc("report_export_request"') &&
    !/runReportExports\([^)]*business/.test(read("src/features/reports/actions.ts")))

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
