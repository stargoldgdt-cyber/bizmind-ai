/**
 * The ledger dashboard, offline (GCC Phase 4).
 *
 * Run with:  npm run test:ledger-dashboard   (part of npm run verify)
 *
 * Proves, without a database, that:
 *   - a month is exactly the engine's half-open UTC range, and bad input is refused
 *   - the validation export writes money exactly and cannot inject a formula
 *   - an incomplete contribution is exported as incomplete, never as a number
 *   - the screens, menu and export route are wired, scoped and read-only
 */

import { readFileSync } from "node:fs"

import { unsignedAmount } from "../src/services/ledger/display"
import {
  buildCsv,
  count,
  ledgerExportRows,
  money,
  text,
  type PnlSummaryRow,
} from "../src/services/ledger/export"
import { previousPeriodLabel, resolvePnlPeriod } from "../src/services/ledger/pnl-period"
import { monthKeyOf, parseLedgerMonth } from "../src/services/ledger/period"

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

const read = (path: string) => readFileSync(path, "utf8")

/* -------------------------------------------------------------------------- */
section("1. A MONTH IS THE ENGINE'S UTC RANGE")

const july = parseLedgerMonth("2026-07")
check(
  "July 2026 is [2026-07-01T00:00Z, 2026-08-01T00:00Z)",
  july?.from === "2026-07-01T00:00:00.000Z" && july?.to === "2026-08-01T00:00:00.000Z",
  JSON.stringify(july)
)
check("its label is 'July 2026'", july?.label === "July 2026", july?.label)
const december = parseLedgerMonth("2026-12")
check("December ends at the first instant of next January", december?.to === "2027-01-01T00:00:00.000Z", december?.to)
for (const bad of ["2026-13", "2026-00", "2026-7", "July", "1999-01", "2026-07-01", "", undefined, null]) {
  check(`refused: ${JSON.stringify(bad)}`, parseLedgerMonth(bad as string | null | undefined) === null)
}
check("a database month becomes its key", monthKeyOf("2026-07-01") === "2026-07")

/* -------------------------------------------------------------------------- */
section("1b. THE PREVIOUS-PERIOD LABEL (migration 0061)")

const thisMonth = resolvePnlPeriod("this_month", july!, null)
check("This Month vs the month before it: 'Jun 2026'", previousPeriodLabel(thisMonth) === "Jun 2026", previousPeriodLabel(thisMonth))

const lastMonth = resolvePnlPeriod("last_month", july!, null)
check("Last Month (June) vs the month before it: 'May 2026'", previousPeriodLabel(lastMonth) === "May 2026", previousPeriodLabel(lastMonth))

const thisQuarter = resolvePnlPeriod("this_quarter", july!, null)
check("This Quarter (Jul-Sep, Q3) vs the quarter before it: 'Q2 2026'", previousPeriodLabel(thisQuarter) === "Q2 2026", previousPeriodLabel(thisQuarter))

const thisYear = resolvePnlPeriod("this_year", july!, null)
check("This Year (2026) vs the year before it: '2025'", previousPeriodLabel(thisYear) === "2025", previousPeriodLabel(thisYear))

const september = parseLedgerMonth("2026-09")
const custom = resolvePnlPeriod("custom", july!, september)
check("Custom Range (Sep 2026) vs the month before it: 'Aug 2026'", previousPeriodLabel(custom) === "Aug 2026", previousPeriodLabel(custom))

check(
  "a period spanning any other number of whole months still produces a sane label, never a crash",
  previousPeriodLabel({ key: "custom", from: "2026-07-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z", label: "x" }) ===
    "May – Jun 2026"
)

/* -------------------------------------------------------------------------- */
section("2. THE EXPORT WRITES MONEY EXACTLY AND SAFELY")

const csv = buildCsv([
  [money("-119.7900"), money("36552.7600"), money("1e3"), money("12,5"), money(null)],
  [text("=HYPERLINK(\"http://x\")"), text("-5"), text("+1"), text("@SUM(A1)"), text("plain")],
  [text("a, b"), text('say "hi"'), text("two\nlines"), count(1154), count(null)],
])
const lines = csv.slice(1).split("\r\n")
check("starts with a UTF-8 byte-order mark", csv.startsWith("﻿"))
check("rows end with CRLF", csv.endsWith("\r\n"))
check(
  "exact decimals pass through untouched; anything else is dropped, never guessed",
  lines[0] === "-119.7900,36552.7600,,,",
  lines[0]
)
check(
  "text that a spreadsheet would evaluate is neutralised",
  lines[1] === `"'=HYPERLINK(""http://x"")",'-5,'+1,'@SUM(A1),plain`,
  lines[1]
)
check(
  "commas, quotes and line breaks are quoted",
  csv.includes('"a, b","say ""hi""","two\nlines",1154,'),
  JSON.stringify(lines[2])
)

const summary: PnlSummaryRow = {
  marketplace_account_id: "00000000-0000-0000-0000-000000000001",
  account_label: "Amazon.ae",
  marketplace_code: "AMAZON",
  currency: "AED",
  period_from: "2026-07-01T00:00:00+00:00",
  period_to: "2026-08-01T00:00:00+00:00",
  gross_sales: "61429.1100",
  sales_refunds: "-5242.1300",
  seller_discounts: "-281.7700",
  net_sales: "55905.2100",
  other_income: "100.0000",
  marketplace_fees: "-6908.8400",
  fulfillment: "-7278.9200",
  advertising: "-5264.6900",
  other_marketplace_costs: "0.0000",
  non_recoverable_vat: "0.0000",
  contribution: null,
  contribution_status: "INCOMPLETE",
  contribution_before_open_items: "36552.7600",
  figures_status: "FINAL",
  input_vat_recoverable: "0.0000",
  input_vat_unresolved: "-119.7900",
  output_vat: "0.0000",
  input_vat_treatment: "UNKNOWN",
  lines: 1154,
  unknown_lines: 0,
  unknown_amount: "0.0000",
  review_lines: 0,
  review_amount: "0.0000",
  conditional_lines: 1,
  row_errors: 0,
  incomplete_reasons: ["VAT_TREATMENT_UNKNOWN"],
  accounts: 1,
  units_sold: "1000.0000",
  cogs: "0.0000",
  units_without_product: "1000.0000",
  units_without_cost: "0.0000",
  sales_without_cost: "61429.1100",
  gross_profit: null,
  gross_profit_status: "INCOMPLETE",
  gross_profit_before_open_items: "36552.7600",
  gross_profit_reasons: ["VAT_TREATMENT_UNKNOWN", "SKU_NOT_MAPPED"],
  orders: 1000,
  average_order_value: "61.4300",
  profit_per_order: null,
  gross_margin_pct: null,
}
const exported = buildCsv(
  ledgerExportRows({
    businessName: "Test, Co",
    accountLabel: "Amazon.ae",
    marketplaceCode: "AMAZON",
    currency: "AED",
    month: july!,
    summary,
    breakdown: [],
    settlements: [],
    quality: [],
  })
)
check("the gross sales line carries the exact figure", exported.includes("Gross sales,61429.1100,Final"))
check(
  "an incomplete contribution is exported with NO amount and the word Incomplete",
  exported.includes("Contribution (before COGS and operating expenses),,Incomplete"),
)
check(
  "the informational figure is labelled as not final",
  exported.includes('"Contribution before open items (informational, not final)",36552.7600,Informational')
)
check("the unresolved VAT is exported exactly", exported.includes('"Input VAT, treatment unknown",-119.7900'))
check("the business name with a comma is quoted", exported.includes('Business,"Test, Co"'))
check(
  "an empty month says so instead of printing zeros",
  buildCsv(ledgerExportRows({ businessName: "B", accountLabel: "A", marketplaceCode: "AMAZON", currency: "AED",
    month: july!, summary: null, breakdown: [], settlements: [], quality: [] })).includes("No lines were posted in this period.")
)

check("the VAT sentence shows the size of the VAT, as text", unsignedAmount("-119.7900") === "119.7900")
check("a positive or missing amount is left alone", unsignedAmount("5.0000") === "5.0000" && unsignedAmount(null) === null)

/* -------------------------------------------------------------------------- */
section("3. THE SCREENS ARE WIRED, SCOPED AND READ-ONLY")

const navigation = read("src/config/navigation.ts")
const routes = read("src/config/routes.ts")
check("the menu has Marketplace profit and Marketplace data quality",
  navigation.includes('href: "/ledger"') && navigation.includes('href: "/ledger/quality"'))
check("the ledger screens require a sign-in", routes.includes('"/ledger"'))

const exportRoute = read("src/app/api/v1/ledger/export/route.ts")
check(
  "the export takes the business from the session and checks the account belongs to it",
  exportRoute.includes("getCurrentUser()") && exportRoute.includes("getActiveBusiness()") &&
    exportRoute.includes("listLedgerAccounts(business.id)") && exportRoute.includes("accounts.find(")
)
check("the export is never cached", exportRoute.includes('"Cache-Control": "no-store"'))

const overview = read("src/app/(app)/ledger/page.tsx")
check(
  "the overview never shows an incomplete contribution as a number",
  overview.includes('s.contribution === null ? "Incomplete"') && overview.includes("— not final")
)
check(
  "the VAT warning reads 'VAT treatment unknown'",
  overview.includes("VAT treatment unknown:")
)
check(
  "the page-local FigureCard is retired -- KpiCard carries every headline figure now (owner request, 2026-09-29)",
  !overview.includes("FigureCard") && overview.includes('from "@/features/overview/components/kpi-card"')
)
check(
  "every headline figure is compared against the period before it, via pnl_summary_change() (migration 0061)",
  overview.includes("change={pct(change?.gross_sales_change_pct)}") &&
    overview.includes("change={pct(change?.contribution_change_pct)}") &&
    overview.includes("change={pct(change?.gross_profit_change_pct)}") &&
    overview.includes("changeLabel={vs}")
)
check(
  "costs, fees and COGS are marked risingIsGood=false -- a bigger fee is never shown as green",
  overview.includes('label="Marketplace fees"') &&
    /label="Marketplace fees"[\s\S]{0,300}?risingIsGood={false}/.test(overview) &&
    /label="Cost of goods sold"[\s\S]{0,400}?risingIsGood={false}/.test(overview)
)

const queries = read("src/features/ledger/queries.ts")
check(
  "getLedgerMonth() and getCurrencyMonth() both call pnl_summary_change() and degrade to null instead of throwing",
  (queries.match(/rpc\("pnl_summary_change"/g) ?? []).length === 2 &&
    queries.includes("change: change.error ? null : (change.data?.[0] ?? null)") &&
    queries.includes("change: changeRow")
)

const ledgerFiles = [
  "src/features/ledger/queries.ts",
  "src/features/ledger/actions.ts",
  "src/app/(app)/ledger/page.tsx",
  "src/app/(app)/ledger/lines/page.tsx",
  "src/app/(app)/ledger/quality/page.tsx",
  "src/app/api/v1/ledger/export/route.ts",
]
check(
  "no ledger screen writes a table directly",
  ledgerFiles.every((file) => !/\.(insert|update|upsert|delete)\(/.test(read(file)))
)
check(
  "no ledger screen mentions the service-role key",
  ledgerFiles.every((file) => !read(file).includes("SUPABASE_SERVICE_ROLE_KEY"))
)
check(
  "the queries module is server-only and reads through the user's session",
  read("src/features/ledger/queries.ts").startsWith('import "server-only"') &&
    read("src/features/ledger/queries.ts").includes('from "@/lib/supabase/server"')
)
const actions = read("src/features/ledger/actions.ts")
check(
  "the classification actions call only the three classification functions",
  JSON.stringify([...actions.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort()) ===
    JSON.stringify(["classification_rule_classify", "classification_rule_impact", "classification_rule_retire"])
)

const migration = read("supabase/migrations/0033_ledger_dashboard.sql")
check(
  "migration 0033 adds only invoker readers",
  !migration.includes("security definer") && (migration.match(/security invoker/g) ?? []).length === 3
)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

process.exit(failed === 0 ? 0 : 1)
