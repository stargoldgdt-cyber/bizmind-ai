/**
 * The report catalogue and its Excel workbooks, offline (GCC Phase 8).
 *
 * Run with:  npm run test:reports   (part of npm run verify)
 *
 * Builds workbooks from invented figures, reads them back with the same
 * library, and proves:
 *   - every figure keeps every digit the database produced (a number when
 *     Excel can hold it exactly, exact text when it cannot)
 *   - an incomplete figure is a blank cell with its status beside it
 *   - text that looks like a formula is never a formula
 *   - an expected payout is never labelled as received
 *   - the download route is session-scoped and read-only
 */

import { readFileSync } from "node:fs"

import ExcelJS from "exceljs"

import { NAVIGATION } from "../src/config/navigation"
import {
  aboutLines,
  isReportKey,
  marketplaceProfitSheets,
  payoutSheets,
  REPORT_CATALOG,
  REPORT_KEYS,
  type Report,
} from "../src/services/reports/catalog"
import { reportWorkbook, spreadsheetNumber, spreadsheetText } from "../src/services/reports/xlsx"
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

type Fn = Database["public"]["Functions"]

/* -------------------------------------------------------------------------- */
section("1. A FIGURE KEEPS EVERY DIGIT")

check("11199.0800 becomes the number 11199.08", spreadsheetNumber("11199.0800") === 11199.08)
check("-0.0001 becomes -0.0001", spreadsheetNumber("-0.0001") === -0.0001)
check("0.0000 becomes 0", spreadsheetNumber("0.0000") === 0)
check("999999999999999.0000 (15 digits) is a number", spreadsheetNumber("999999999999999.0000") === 999999999999999)
check("9999999999999999.9999 (20 digits) stays exact text",
  spreadsheetNumber("9999999999999999.9999") === "9999999999999999.9999")
check("1234567890123.4567 (17 digits) stays exact text",
  spreadsheetNumber("1234567890123.4567") === "1234567890123.4567")
check("text that is not a decimal is left alone", spreadsheetNumber("n/a") === "n/a")
check("a formula-looking text is defused", spreadsheetText("=HYPERLINK(\"x\")") === "'=HYPERLINK(\"x\")" &&
  spreadsheetText("@SUM(A1)") === "'@SUM(A1)" && spreadsheetText("plain") === "plain")

/* -------------------------------------------------------------------------- */
section("2. A WORKBOOK, READ BACK")

const summary = {
  marketplace_account_id: "00000000-0000-0000-0000-000000000001", account_label: "=cmd|' /C calc'!A0",
  marketplace_code: "AMAZON", currency: "AED", period_from: "2026-07-01T00:00:00Z", period_to: "2026-08-01T00:00:00Z",
  gross_sales: "61429.1100", sales_refunds: "-5242.1300", seller_discounts: "-281.7700", net_sales: "55905.2100",
  other_income: "100.0000", marketplace_fees: "-6908.8400", fulfillment: "-7278.9200", advertising: "-5264.6900",
  other_marketplace_costs: "0.0000", non_recoverable_vat: "0.0000", contribution: null, contribution_status: "INCOMPLETE",
  contribution_before_open_items: "36552.7600", figures_status: "FINAL", input_vat_recoverable: "0.0000",
  input_vat_unresolved: "-119.7900", output_vat: "0.0000", input_vat_treatment: "UNKNOWN", lines: 1154, unknown_lines: 0,
  unknown_amount: "0.0000", review_lines: 0, review_amount: "0.0000", conditional_lines: 1, row_errors: 0,
  incomplete_reasons: ["VAT_TREATMENT_UNKNOWN"], accounts: 1, units_sold: "296.0000", cogs: "0.0000",
  units_without_product: "296.0000", units_without_cost: "0.0000", sales_without_cost: "59000.0000", gross_profit: null,
  gross_profit_status: "INCOMPLETE", gross_profit_before_open_items: "36552.7600",
  gross_profit_reasons: ["VAT_TREATMENT_UNKNOWN", "SKU_NOT_MAPPED"],
} satisfies Fn["pnl_summary"]["Returns"][number]

const payout = {
  payout_key: "00000000-0000-0000-0000-000000000002", source: "SETTLEMENT_REPORT", marketplace_account_id: summary.marketplace_account_id,
  account_label: "Amazon.ae", marketplace_code: "AMAZON", currency: "AED", reference: "INVENTED-1", source_file_id: null,
  file_name: null, period_start: "2026-06-20T00:00:00Z", period_end: "2026-07-04T00:00:00Z",
  expected_date: "2026-07-04T08:00:00Z", expected_amount: "9999999999999999.9999", settlement_lines_total: "9999999999999999.9999",
  settlement_lines: 3, marketplace_status: "ADDS_UP", bank_receipt_status: "NOT_CONNECTED", bank_receipt_amount: null,
  bank_receipt_date: null,
} satisfies Fn["expected_payouts"]["Returns"][number]

const report: Report = {
  key: "marketplace-profit",
  title: "Marketplace profit",
  about: aboutLines({ businessName: "+Invented Co", period: "July 2026", generatedAt: "2026-09-17 10:00 UTC" }),
  sheets: [
    ...marketplaceProfitSheets([summary], [{ ...summary, account_label: "All AED accounts" }]),
    ...payoutSheets([payout], []),
  ],
}

const buffer = await reportWorkbook(report)
const workbook = new ExcelJS.Workbook()
await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
const names = workbook.worksheets.map((w) => w.name)
check("sheets: About, By account, By currency, Expected payouts, Expected cashflow",
  JSON.stringify(names) === JSON.stringify(["About", "By account", "By currency", "Expected payouts", "Expected cashflow"]),
  JSON.stringify(names))

const byAccount = workbook.getWorksheet("By account")!
const header = (byAccount.getRow(1).values as ExcelJS.CellValue[]).slice(1)
const at = (label: string) => header.indexOf(label) + 1
const data = byAccount.getRow(2)
check("gross sales is the number 61429.11", data.getCell(at("Gross sales")).value === 61429.11)
check("an incomplete contribution is a blank cell", data.getCell(at("Contribution")).value === null)
check("its status says Incomplete", data.getCell(at("Contribution status")).value === "Incomplete")
check("an incomplete gross profit is blank, and so is its unfinished cost of goods",
  data.getCell(at("Gross profit")).value === null && data.getCell(at("Cost of goods sold")).value === null)
check("the reasons are written out", data.getCell(at("Why not final")).value === "VAT_TREATMENT_UNKNOWN, SKU_NOT_MAPPED")
check("a formula-looking account name is text, not a formula",
  data.getCell(at("Account")).value === "'=cmd|' /C calc'!A0" && data.getCell(at("Account")).type !== ExcelJS.ValueType.Formula)
check("money cells carry a money format", String(data.getCell(at("Gross sales")).numFmt).includes("#,##0.00"))

const about = workbook.getWorksheet("About")!
const aboutText = JSON.stringify(about.getSheetValues())
check("the About sheet explains blanks and signs", aboutText.includes("never read a blank as zero") && aboutText.includes("Money in is positive"))
check("the business name is defused too", aboutText.includes("'+Invented Co"))

const payouts = workbook.getWorksheet("Expected payouts")!
const payoutHeader = (payouts.getRow(1).values as ExcelJS.CellValue[]).slice(1)
const pAt = (label: string) => payoutHeader.indexOf(label) + 1
check("the payout sheet has separate expected and bank columns",
  payoutHeader.includes("Expected marketplace payout") && payoutHeader.includes("Actual bank receipt"))
check("a 20-digit expected payout is kept as exact text",
  payouts.getRow(2).getCell(pAt("Expected marketplace payout")).value === "9999999999999999.9999")
check("the bank column reads Not connected", payouts.getRow(2).getCell(pAt("Actual bank receipt")).value === "Not connected")
check("dates are the UTC calendar day", payouts.getRow(2).getCell(pAt("Expected on")).value === "2026-07-04")
check("an empty sheet says so", workbook.getWorksheet("Expected cashflow")!.getRow(2).getCell(1).value === "Nothing to show for this period.")

/* -------------------------------------------------------------------------- */
section("3. THE CATALOGUE, THE ROUTE AND THE MENU")

check("five reports", REPORT_KEYS.length === 5 && REPORT_KEYS.every((k) => REPORT_CATALOG[k].title.length > 0))
check("an unknown report key is refused", !isReportKey("../../etc") && !isReportKey("ledger") && isReportKey("payouts"))
check("the payouts report says expected, never received",
  REPORT_CATALOG.payouts.description.includes("Expected, never received"))
const ROUTE = read("src/app/api/v1/reports/[report]/route.ts")
const QUERIES = read("src/features/reports/queries.ts")
check("the route needs a session and takes the business from it",
  ROUTE.includes("getCurrentUser()") && ROUTE.includes("getActiveBusiness()") && !ROUTE.includes("business_id"))
check("the route leaks no internal error", ROUTE.includes("The report could not be prepared. Try again."))
check("reports are read through the user's session, never the worker key, and write nothing",
  QUERIES.includes('from "@/lib/supabase/server"') && !/service[_-]?role|callTrusted/i.test(QUERIES) &&
    !/\.(insert|update|delete|upsert)\(/.test(QUERIES))
check("the menu has Reports", NAVIGATION.flatMap((s) => s.items).some((i) => i.href === "/ledger/reports" && i.enabled))

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
