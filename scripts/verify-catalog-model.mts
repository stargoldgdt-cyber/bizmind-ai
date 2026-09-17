/**
 * Product master, SKU matching and COGS, offline (GCC Phase 6).
 *
 * Run with:  npm run test:catalog   (part of npm run verify)
 *
 * Proves, without a database, that:
 *   - SKU normalisation and cost validation match migration 0035 exactly
 *   - the migration keeps costs append-only, matching person-confirmed, and
 *     every writer role-checked and audited
 *   - gross profit is exported empty while it is incomplete
 *   - the screens, menu and protected routes are wired, and never calculate
 */

import { readFileSync } from "node:fs"

import { NAVIGATION, isNavItemActive } from "../src/config/navigation"
import { PROTECTED_PREFIXES } from "../src/config/routes"
import { UNIT_COST_PATTERN, normalizeSku } from "../src/services/catalog/sku"
import { buildCsv, ledgerExportRows, type PnlSummaryRow } from "../src/services/ledger/export"
import { parseLedgerMonth } from "../src/services/ledger/period"

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
const MIGRATION = read("supabase/migrations/0035_product_master_cogs.sql")

/* -------------------------------------------------------------------------- */
section("1. SKU NORMALISATION (SUGGESTIONS ONLY)")

check("the migration's own example: ' sg-t84d/Black ' -> SGT84DBLACK", normalizeSku(" sg-t84d/Black ") === "SGT84DBLACK")
check(
  "the migration's self-check uses the same example",
  MIGRATION.includes("public.sku_normalize(' sg-t84d/Black ') <> 'SGT84DBLACK'")
)
check("SQL and TypeScript strip the same characters", MIGRATION.includes("regexp_replace(coalesce(p_value, ''), '[^A-Za-z0-9]', '', 'g')"))
check("empty and missing values normalise to nothing", normalizeSku(null) === "" && normalizeSku(undefined) === "" && normalizeSku("--") === "")
check("Arabic letters are not treated as letters (never a false match)", normalizeSku("كوب-1") === "1")

/* -------------------------------------------------------------------------- */
section("2. COST VALIDATION MATCHES THE DATABASE")

check(
  "the database uses the same pattern",
  MIGRATION.includes(`p_unit_cost, '') !~ '${UNIT_COST_PATTERN.source}'`),
  UNIT_COST_PATTERN.source
)
for (const good of ["0", "42", "42.5", "42.50", "0.0001", "9999999999999999.9999"]) {
  check(`accepted: ${good}`, UNIT_COST_PATTERN.test(good))
}
for (const bad of ["", "-1", "1,000", "12,5", "1.23456", "1e3", " 1", "abc", ".5", "10000000000000000"]) {
  check(`refused: ${JSON.stringify(bad)}`, !UNIT_COST_PATTERN.test(bad))
}

/* -------------------------------------------------------------------------- */
section("3. THE MIGRATION'S GUARANTEES")

for (const table of ["catalog_products", "sku_aliases", "product_costs"]) {
  check(`${table} has RLS enabled and forced`, MIGRATION.includes(`alter table public.${table}`) &&
    new RegExp(`alter table public\\.${table}\\s+force row level security`).test(MIGRATION))
}
check("a cost can only be withdrawn, never edited", MIGRATION.includes("A product cost cannot be edited"))
check("a cost is deleted only with its business or product", MIGRATION.includes("A product cost cannot be deleted"))
check("one confirmed product per SKU per marketplace", MIGRATION.includes("create unique index sku_aliases_one_confirmed"))
check("a SKU must appear in the business's files to be matched", MIGRATION.includes("does not appear in this business''s marketplace files"))
check("a new match replaces the old one, kept as rejected", MIGRATION.includes("'Replaced by a new mapping'"))
check("rejected suggestions are never offered again", MIGRATION.includes("and r.status = 'REJECTED'"))
check("no table stores a customer's identity", !/customer|buyer|email|phone|address/i.test(
  MIGRATION.slice(MIGRATION.indexOf("create table public.catalog_products"), MIGRATION.indexOf("-- 4. Lines with quantity"))
    .replace(/ledger_text_has_email/g, "")
))
for (const writer of ["catalog_product_create", "catalog_product_update", "sku_alias_decide", "sku_alias_remove", "product_cost_add", "product_cost_retire"]) {
  const start = MIGRATION.indexOf(`create function public.${writer}(`)
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start))
  check(
    `${writer}: definer, owner/admin only, audited`,
    start > 0 && body.includes("security definer") && body.includes("array['OWNER', 'ADMIN']") && body.includes("write_audit_log"),
  )
}
check("COGS counts only product-sales lines with a quantity (refunds keep their cost: B17)",
  MIGRATION.includes("(l.category = 'PRODUCT_SALES' and l.quantity is not null)   as is_cost_line"))
check("the cost in force on the sale date is used", MIGRATION.includes("pcost.effective_from <= (l.posted_at at time zone 'UTC')::date"))
check("gross profit is NULL unless final",
  MIGRATION.includes("when j.contribution_incomplete or j.units_no_product > 0 or j.units_no_cost > 0 then null"))
check("marketplace-level lines are never allocated to products (A7)", MIGRATION.includes("else 'NOT_ALLOCATED'"))

/* -------------------------------------------------------------------------- */
section("4. AN INCOMPLETE GROSS PROFIT IS EXPORTED EMPTY")

const july = parseLedgerMonth("2026-07")!
const summary: PnlSummaryRow = {
  marketplace_account_id: "00000000-0000-0000-0000-000000000001", account_label: "noon", marketplace_code: "NOON",
  currency: "AED", period_from: july.from, period_to: july.to, gross_sales: "250.0000", sales_refunds: "0.0000",
  seller_discounts: "0.0000", net_sales: "250.0000", other_income: "0.0000", marketplace_fees: "-20.0000",
  fulfillment: "-8.0000", advertising: "-20.0000", other_marketplace_costs: "0.0000", non_recoverable_vat: "0.0000",
  contribution: "202.0000", contribution_status: "FINAL", contribution_before_open_items: "202.0000", figures_status: "FINAL",
  input_vat_recoverable: "0.0000", input_vat_unresolved: "0.0000", output_vat: "0.0000", input_vat_treatment: "NON_RECOVERABLE",
  lines: 8, unknown_lines: 0, unknown_amount: "0.0000", review_lines: 0, review_amount: "0.0000", conditional_lines: 0,
  row_errors: 0, incomplete_reasons: [], accounts: 1, units_sold: "3.0000", cogs: "-65.0000",
  units_without_product: "0.0000", units_without_cost: "1.0000", sales_without_cost: "50.0000", gross_profit: null,
  gross_profit_status: "INCOMPLETE", gross_profit_before_open_items: "137.0000", gross_profit_reasons: ["COST_MISSING"],
}
const csv = buildCsv(ledgerExportRows({
  businessName: "Test", accountLabel: "noon", marketplaceCode: "NOON", currency: "AED", month: july,
  summary, breakdown: [], settlements: [], quality: [],
})).split("\r\n")
check("gross profit row: no number, Incomplete", csv.includes("Gross profit (contribution - COGS),,Incomplete"), csv.join(" | "))
check("COGS so far is shown, marked Incomplete", csv.includes("Cost of goods sold (units sold x dated cost),-65.0000,Incomplete"))
check("the informational figure is labelled as such", csv.includes('"Gross profit before open items (informational, not final)",137.0000,Informational'))
check("the reason is named", csv.includes("Reasons gross profit is incomplete,COST_MISSING"))

/* -------------------------------------------------------------------------- */
section("5. SCREENS, MENU AND ROUTES")

const items = NAVIGATION.flatMap((s) => s.items)
const find = (href: string) => items.find((i) => i.href === href)
check("the menu has Product profit, Products and costs, SKU matching", !!find("/ledger/products") && !!find("/catalog") && !!find("/catalog/mapping"))
check("a product page highlights Products and costs", isNavItemActive(find("/catalog")!, "/catalog/products/abc"))
check("SKU matching highlights only itself", !isNavItemActive(find("/catalog")!, "/catalog/mapping") &&
  isNavItemActive(find("/catalog/mapping")!, "/catalog/mapping"))
check("product profit does not highlight Marketplace profit", !isNavItemActive(find("/ledger")!, "/ledger/products"))
check("/catalog is a protected prefix", PROTECTED_PREFIXES.includes("/catalog"))

const PAGES = {
  catalog: read("src/app/(app)/catalog/page.tsx"),
  product: read("src/app/(app)/catalog/products/[id]/page.tsx"),
  mapping: read("src/app/(app)/catalog/mapping/page.tsx"),
  profit: read("src/app/(app)/ledger/products/page.tsx"),
  overview: read("src/app/(app)/ledger/page.tsx"),
}
const ACTIONS = read("src/features/catalog/actions.ts")
const QUERIES = read("src/features/catalog/queries.ts")
for (const [name, source] of Object.entries(PAGES)) {
  check(`${name}: no service-role access, no arithmetic on money`, !/service[_-]?role/i.test(source) &&
    !/\bNumber\(|parseFloat\(|\.toFixed\(/.test(source))
}
check("the overview shows gross profit only when the engine gives one", PAGES.overview.includes('s.gross_profit === null ? "Incomplete"'))
check("product profit reads pnl_by_product", QUERIES.includes('rpc("pnl_by_product"'))
check("every write goes through the audited functions",
  ["catalog_product_create", "catalog_product_update", "sku_alias_decide", "sku_alias_remove", "product_cost_add", "product_cost_retire"]
    .every((fn) => ACTIONS.includes(`rpc("${fn}"`)) && !/\.from\(/.test(ACTIONS))
check("actions take the business from the session, never from input", ACTIONS.includes("getActiveBusiness()") && !/businessId:\s*z\./.test(ACTIONS))
check("suggestions are only offered: nothing is matched without a click",
  !/sku_alias_decide/.test(QUERIES) && read("src/features/catalog/components/sku-match-controls.tsx").includes('decide(s.product_id, "CONFIRMED")'))

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
