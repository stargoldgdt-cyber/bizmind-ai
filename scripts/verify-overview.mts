/**
 * The home dashboard, offline.
 *
 * Run with:  npm run test:overview   (part of npm run verify)
 *
 * Proves, without a database:
 *   - migration 0043 adds only read-only invoker readers, closed to anon
 *   - the page and its components calculate nothing (figures come from SQL)
 *   - an expected payout is never called received on the dashboard
 *   - an incomplete figure is never shown as final
 *   - sign-in lands on the new dashboard; the old one stays, labelled legacy
 */

import { readFileSync } from "node:fs"

import { NAVIGATION } from "../src/config/navigation"
import { formatMoney } from "../src/lib/format"
import { DASHBOARD_ROUTE, isProtectedPath } from "../src/config/routes"
import { parseLedgerMonth, previousLedgerMonth } from "../src/services/ledger/period"
import { contributionStory, findings, openItems, reasonText } from "../src/services/overview/findings"
import { bucketOf } from "../src/features/overview/components/products-table"
import type { Database } from "../src/types/database"
import type { BridgeStep, ProductRow } from "../src/features/overview/queries"

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
const MIGRATION = read("supabase/migrations/0043_dashboard_readers.sql")
const PAGE = read("src/app/(app)/overview/page.tsx")
const SECTIONS = read("src/features/overview/components/sections.tsx")
const KPI = read("src/features/overview/components/kpi-card.tsx")
const WATERFALL = read("src/features/overview/components/waterfall-chart.tsx")
const TREND = read("src/features/overview/components/trend-chart.tsx")
const QUERIES = read("src/features/overview/queries.ts")
const FINDINGS = read("src/services/overview/findings.ts")
const UI = [PAGE, SECTIONS, KPI, WATERFALL, TREND, QUERIES, FINDINGS]

/* ---------------------------------------------------------------------------- */
section("1. MIGRATION 0043: READ-ONLY INVOKER READERS")

const functions = [...MIGRATION.matchAll(/create (?:or replace )?function public\.(\w+)/g)].map((m) => m[1])
check(
  "it adds exactly the seven dashboard functions",
  JSON.stringify([...functions].sort()) ===
    JSON.stringify(["dashboard_accounts", "dashboard_change", "dashboard_cost_breakdown", "dashboard_daily",
      "dashboard_overview", "dashboard_pct", "dashboard_waterfall"]),
  functions.join(", ")
)
check("none is SECURITY DEFINER", !/security definer/i.test(MIGRATION))
check("every reader is SECURITY INVOKER", (MIGRATION.match(/^security invoker$/gm) ?? []).length === 5)
check("it creates no table, view or column", !/create table|create (or replace )?view|alter table/i.test(MIGRATION))
check("it writes nothing", !/\b(insert into|update public\.|delete from)\b/i.test(MIGRATION))
check("closed to anon, open to signed-in members (RLS decides what they see)",
  MIGRATION.includes("revoke all on function %s from anon, public") &&
    MIGRATION.includes("grant execute on function %s to authenticated"))
check("it verifies itself when applied", MIGRATION.includes("must be SECURITY INVOKER and closed to anon"))
check("money leaves the database as exact text", /gross_sales\s+text/.test(MIGRATION) && /amount\s+text/.test(MIGRATION))
check("the bank is never read or invented", !/bank_transactions|bank_received/i.test(MIGRATION))

/* ---------------------------------------------------------------------------- */
section("2. THE SCREEN CALCULATES NOTHING")

const moneyFields = "gross_sales|net_sales|contribution|gross_profit|net_profit|marketplace_costs|expected_inflow|expected_amount|total|cogs|advertising"
const arithmetic = new RegExp(`\\.(${moneyFields})\\b\\s*[-+*/]|[-+*/]\\s*\\w+\\.(${moneyFields})\\b`)
check("no money field is added, subtracted, multiplied or divided", UI.every((src) => !arithmetic.test(src)),
  UI.map((src) => src.match(arithmetic)?.[0]).filter(Boolean).join(" | "))
check("no money text is turned into a JavaScript number",
  UI.every((src) => !new RegExp(`(Number|parseFloat|parseInt)\\([^)]*\\.(${moneyFields})\\b`).test(src)))
check("products are ordered with compareMoney, not by converting money", PAGE.includes("compareMoney(b.net_sales, a.net_sales)"))
check("the page reads through the session client, never the service-role key",
  UI.every((src) => !/service[-_ ]?role|createServiceClient|SUPABASE_SERVICE/i.test(src)))
check("every figure arrives from the dashboard readers", ["dashboard_overview", "dashboard_waterfall_steps", "dashboard_daily",
  "dashboard_monthly", "dashboard_cost_breakdown", "dashboard_accounts"].every((fn) => QUERIES.includes(`"${fn}"`)))
check("the waterfall is worked out from the overview row already read, not a second pass (0049)",
  QUERIES.includes('rpc("dashboard_waterfall_steps", { p_overview: row') && !QUERIES.includes('rpc("dashboard_waterfall",'))
const MONTHLY = read("src/features/overview/components/monthly-trend.tsx")
check("the monthly trend places bars and the line from SQL positions, with a legend and a table",
  MONTHLY.includes("p.bar_to") && MONTHLY.includes("month_contribution_y") && MONTHLY.includes("Show as a table") &&
    MONTHLY.includes("not final"))
const PERIOD = read("src/services/overview/period.ts")
check("a period is whole months ending on the chosen month, compared with as many months before",
  PERIOD.includes("previousLabel: single ? shiftMonth(end, -1).label : `the previous ${months} months`") &&
    read("supabase/migrations/0049_executive_dashboard.sql").includes("make_interval(months => v_months)"))
check("charts place bars from the 0-1000 positions SQL returned",
  WATERFALL.includes("s.bar_to") && WATERFALL.includes("s.bar_from") && TREND.includes("p.gross_y"))

/* ---------------------------------------------------------------------------- */
section("3. EXPECTED IS NEVER RECEIVED; INCOMPLETE IS NEVER FINAL")

type Overview = Database["public"]["Functions"]["dashboard_overview"]["Returns"][number]
const base: Overview = {
  currency: "AED", scope_label: "All AED marketplaces", accounts: 2, has_marketplace_data: true, lines: 40,
  review_lines: 0, unknown_lines: 0, gross_sales: "1000.0000", sales_refunds: "-60.0000", seller_discounts: "0.0000",
  net_sales: "940.0000", other_income: "0.0000", marketplace_fees: "-150.0000", fulfillment: "-80.0000",
  advertising: "-120.0000", other_marketplace_costs: "0.0000", non_recoverable_vat: "0.0000",
  marketplace_costs: "-350.0000", figures_status: "FINAL", contribution: "590.0000", contribution_status: "FINAL",
  contribution_before_open_items: "590.0000", contribution_reasons: [], units_sold: "10.0000", cogs: "300.0000",
  units_without_product: "0.0000", units_without_cost: "0.0000", gross_profit: "290.0000", gross_profit_status: "FINAL",
  gross_profit_before_open_items: "290.0000", gross_profit_reasons: [], net_available: true,
  operating_expenses: "-100.0000", external_advertising: "0.0000", net_profit: "190.0000", net_profit_status: "FINAL",
  net_profit_before_open_items: "190.0000", net_profit_reasons: [], input_vat_treatment: "RECOVERABLE",
  refunds_pct_of_gross: 6, costs_pct_of_net_sales: 37.2, fees_pct_of_net_sales: 16, advertising_pct_of_net_sales: 12.8,
  contribution_margin_pct: 62.8, gross_margin_pct: 30.9, net_margin_pct: 20.2, prev_has_marketplace_data: true,
  prev_snapshot: null,
  gross_sales_change_pct: 5, net_sales_change_pct: 4, marketplace_costs_change_pct: 2, contribution_change_pct: 3,
  gross_profit_change_pct: 1, net_profit_change_pct: -2, expected_payouts: 3, expected_inflow: "700.0000",
  payouts_in_doubt: 0, open_quality_items: 0, unmatched_skus: 0, unplaced_expense_categories: 0,
}

const clean = findings(base, "AED", "2026-07", "/ledger?account=all-AED&month=2026-07")
const payout = clean.find((f) => f.id === "payouts")
check("the payout finding says expected, and says it is not confirmed as received",
  payout?.title.startsWith("Expected") === true && payout.body.includes("Not confirmed as received: no bank is connected"),
  payout?.body)
const everyWord = [...clean, ...openItems(base, "2026-07")].map((f) => `${f.title} ${f.body}`).join(" ")
check("nothing else on the dashboard mentions money received",
  !/received/i.test(everyWord.replace("Not confirmed as received", "")), everyWord)
check("the screen's words agree: 'Not money received' and 'Actual bank receipt'",
  SECTIONS.includes("Not money received: no bank is connected.") && SECTIONS.includes("Actual bank receipt") &&
    SECTIONS.includes("BANK_RECEIPT_STATUS_LABEL.NOT_CONNECTED"))
check("advertising at 10% or more, and refunds at 5% or more, are pointed out",
  clean.some((f) => f.id === "ads-share") && clean.some((f) => f.id === "refunds"))
check("a clean month has nothing to fix", openItems(base, "2026-07").length === 0)

const incomplete: Overview = {
  ...base, contribution: null, contribution_status: "INCOMPLETE", contribution_margin_pct: null,
  contribution_reasons: ["VAT_TREATMENT_UNKNOWN"], gross_profit: null, gross_profit_status: "INCOMPLETE",
  gross_profit_reasons: ["VAT_TREATMENT_UNKNOWN", "SKU_NOT_MAPPED"], unmatched_skus: 2, units_without_product: "3.0000",
  net_profit: null, net_profit_status: "INCOMPLETE", net_profit_reasons: ["EXPENSES_UNCLASSIFIED"],
  unplaced_expense_categories: 1, payouts_in_doubt: 1, unknown_lines: 4,
}
const todo = openItems(incomplete, "2026-07").map((f) => f.id)
check("each reason becomes one thing to fix, with where to fix it",
  ["unknown", "vat", "skus", "expenses", "mismatch"].every((id) => todo.includes(id)), todo.join(", "))
check("an incomplete contribution produces no 'final margin' card",
  !findings(incomplete, "AED", "2026-07", "/ledger").some((f) => f.id === "margin"))
check("a month without marketplace data produces no observations",
  findings({ ...base, has_marketplace_data: false }, "AED", "2026-07", "/ledger").length === 0)
check("reasons read as plain words", reasonText(["COST_MISSING"]) === "some products have no cost for the sale date")
check("a KPI that is incomplete shows the word, never a number",
  PAGE.includes('o.contribution === null ? "Incomplete"') && PAGE.includes('o.gross_profit === null ? "Incomplete"') &&
    PAGE.includes('o.net_profit === null ? "Incomplete"'))
check("a 'so far' figure is always labelled not final", PAGE.includes("— not final"))
check("net profit on a shared-currency account points to the whole currency instead",
  PAGE.includes("o.net_available ?") && PAGE.includes("net profit is shown for the whole business"))
check("status is never colour alone: the waterfall labels 'not final', the change chip says Up or Down",
  WATERFALL.includes("not final") && KPI.includes('"Up" : "Down"'))

/* ---------------------------------------------------------------------------- */
section("3b. THE INSIGHT CARD: WHY CONTRIBUTION CHANGED, FROM THE BRIDGE'S OWN DELTAS")

const step = (label: string, kind: BridgeStep["kind"], amount: string): BridgeStep => ({
  step: 1, label, kind, amount, status: "FINAL", bar_from: 0, bar_to: 0, zero_at: 0,
})
const bridge: BridgeStep[] = [
  step("Previous contribution", "START", "500.0000"),
  step("Net sales", "DELTA", "20.0000"),
  step("Marketplace fees", "DELTA", "-90.0000"),
  step("Advertising", "DELTA", "5.0000"),
  step("Current contribution", "END", "435.0000"),
]

const story = contributionStory(base, bridge, "June 2026", "/ledger")
const ninety = formatMoney("90.0000", "AED")
const twenty = formatMoney("20.0000", "AED")
check("names the single biggest mover first, by dollar size, not the order SQL happened to list them",
  story?.body.startsWith(`The biggest reason: marketplace fees cost you an extra ${ninety}`) === true, story?.body)
check("names a real second factor too, smaller but still material",
  story?.body.includes(`, and net sales added ${twenty}`) === true, story?.body)
check("the smallest mover (advertising, AED 5) is left out -- only the top two are named", story?.body.includes("advertising") === false, story?.body)
check("the headline direction matches contribution_change_pct's own sign, never re-derived from the bridge",
  story?.title === "Contribution is up 3.0% vs June 2026", story?.title)
check("no comparison period yields no story, not a guess",
  contributionStory({ ...base, prev_has_marketplace_data: false }, bridge, "June 2026", "/ledger") === null)
check("an incomplete contribution yields no story either",
  contributionStory({ ...base, contribution: null }, bridge, "June 2026", "/ledger") === null)
check("an empty bridge (e.g. every category flat) yields no story",
  contributionStory(base, [], "June 2026", "/ledger") === null)

const fallingSalesStory = contributionStory(
  base,
  [
    step("Previous contribution", "START", "500.0000"),
    step("Net sales", "DELTA", "-30.0000"),
    step("Marketplace fees", "DELTA", "10.0000"),
    step("Current contribution", "END", "480.0000"),
  ],
  "June 2026",
  "/ledger"
)
check(
  "a revenue line (net sales) that FELL reads as falling, never as a 'cost' -- a cost is only ever a cost line",
  fallingSalesStory?.body.includes(`net sales fell, taking away ${formatMoney("30.0000", "AED")}`) === true,
  fallingSalesStory?.body
)
const findingsSource = readFileSync("src/services/overview/findings.ts", "utf8")
check("the mover ordering never converts a bridge amount to a JavaScript number",
  findingsSource.includes("compareMoney") && !/(Number|parseFloat|parseInt)\([^)]*\.amount/.test(findingsSource))

/* ---------------------------------------------------------------------------- */
section("4. ROUTING AND NAVIGATION")

check("sign-in, onboarding and business switch land on /overview", DASHBOARD_ROUTE === "/overview")
check("/overview requires a signed-in user", isProtectedPath("/overview") && isProtectedPath("/overview/anything"))
const items = NAVIGATION.flatMap((s) => s.items)
check("'Dashboard' opens the new dashboard", items.some((i) => i.label === "Dashboard" && i.href === "/overview" && i.enabled))
// 2026-09-21 (owner): the legacy spreadsheet-import screens are hidden from the
// menu, kept in the code until Phase 10 retires them.
const LEGACY = ["/dashboard", "/ask", "/sales", "/products", "/profit", "/health", "/channels", "/data-quality"]
check("every legacy screen is hidden from the menu, and kept for Phase 10",
  LEGACY.every((href) => items.some((i) => i.href === href && !i.enabled)))
check("the menu offers only marketplace screens",
  items.filter((i) => i.enabled).every((i) => !LEGACY.includes(i.href)))
check("Ask BizMind in the menu is the marketplace one",
  items.some((i) => i.label === "Ask BizMind" && i.href === "/ledger/ask" && i.enabled))
const july = parseLedgerMonth("2026-07")!
const january = parseLedgerMonth("2026-01")!
check("last month is the calendar month before, across a year end",
  previousLedgerMonth(july).key === "2026-06" && previousLedgerMonth(january).key === "2025-12")

/* ---------------------------------------------------------------------------- */
section("5. PRODUCT PERFORMANCE TABS: BUCKETING AN ALREADY-FINAL MARGIN")

const product = (margin: string | null, cogsStatus: ProductRow["cogs_status"] = "COSTED"): ProductRow => ({
  currency: "AED",
  row_kind: "PRODUCT",
  product_id: "p1",
  product_name: "Test product",
  product_category: null,
  raw_sku: null,
  marketplace_code: "AMAZON",
  lines: 1,
  units_sold: "1.0000",
  net_sales: "100.0000",
  other_income: "0.0000",
  costs: "0.0000",
  cogs: "10.0000",
  contribution: "90.0000",
  gross_profit: "80.0000",
  gross_margin_percent: margin,
  cogs_status: cogsStatus,
})

check("a healthy margin (5% or more) is Best Performers", bucketOf(product("22.5000")) === "best")
check("exactly 5% is still Best Performers (the line is inclusive on the good side)", bucketOf(product("5.0000")) === "best")
check("a thin margin (0% up to 5%) is Watch", bucketOf(product("4.9000")) === "watch")
check("exactly 0% is Watch, not Losing (breakeven is not a loss)", bucketOf(product("0.0000")) === "watch")
check("a negative margin is Losing Money", bucketOf(product("-3.2000")) === "losing")
check("a product with no final cost is bucketed nowhere, not guessed", bucketOf(product(null, "NO_COST")) === null)
check("a product only partly costed is bucketed nowhere either", bucketOf(product("18.0000", "PARTLY_COSTED")) === null)
const productsTableSource = readFileSync("src/features/overview/components/products-table.tsx", "utf8")
check(
  "the comparison never converts the margin to a JavaScript number",
  productsTableSource.includes("compareMoney") &&
    !/(Number|parseFloat|parseInt)\([^)]*gross_margin_percent/.test(productsTableSource)
)

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
