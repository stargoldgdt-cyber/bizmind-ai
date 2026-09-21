/**
 * SKU setup, offline (migration 0045).
 *
 * Run with:  npm run test:sku-setup   (part of npm run verify)
 *
 * Proves, without a database:
 *   - automatic matching is identical SKUs only (spaces, dashes, capitals),
 *     never replaces a confirmed mapping and never re-makes a rejected one
 *   - a cost belongs to the product: equal costs are one cost, different costs
 *     for one Product SKU are refused with every row named
 *   - a first cost applies from the first sale; a changed cost from today;
 *     no cost is ever edited
 *   - the one-sheet workbook reads back exactly what was written
 *   - nothing touches the ledger, and the screens calculate nothing
 */

import { readFileSync } from "node:fs"

import ExcelJS from "exceljs"

import { checkSkuSetup, marketplaceCodeOf, SKU_SETUP_COLUMNS, type SkuSetupRecord } from "../src/services/catalog/sku-setup"
import { readSkuSetupWorkbook, skuSetupWorkbook } from "../src/services/catalog/sku-setup-workbook"

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
const SQL = read("supabase/migrations/0045_sku_setup.sql")
const body = (fn: string) => {
  const start = SQL.indexOf(`create function public.${fn}(`)
  const alt = SQL.indexOf(`create or replace function public.${fn}(`)
  const from = start >= 0 ? start : alt
  return from < 0 ? "" : SQL.slice(from, SQL.indexOf("\n$$;", from))
}

/* ---------------------------------------------------------------------------- */
section("1. AUTOMATIC MATCHING: IDENTICAL SKUS ONLY")

const identity = body("sku_identity_key")
check("the identity key ignores only spaces, dashes and capitals", identity.includes("upper(regexp_replace(coalesce(p_value, ''), '[[:space:]-]+', '', 'g'))"))
check("it verifies itself: dots, underscores and extra words still differ",
  SQL.includes("sku_identity_key('SG.T84D') = public.sku_identity_key('SGT84D')") &&
    SQL.includes("sku_identity_key('SG-T84D B Blue Fog FBA') = public.sku_identity_key('SG-T84D')"))
const auto = body("sku_auto_match")
check("only SKUs with no confirmed product are considered (a mapping is never replaced)",
  auto.includes("and s.raw_sku = ft.raw_sku and s.status = 'CONFIRMED'") && /not exists \(\s*select 1 from public\.sku_aliases s/.test(auto))
check("it matches only when exactly one product fits", auto.includes("cardinality(c.products) = 1"))
check("a pairing a person rejected is never made again", auto.includes("r.status = 'REJECTED'"))
check("every automatic match is labelled and audited",
  auto.includes("'AUTOMATIC'") && auto.includes("'Matched automatically: identical SKU'") && auto.includes("sku_alias.matched_automatically"))
check("it never updates an existing mapping", !/update public\.sku_aliases/.test(auto) && auto.includes("on conflict do nothing"))
check("a viewer cannot trigger it; staff (who import) can",
  auto.includes("array['OWNER', 'ADMIN', 'STAFF']") && auto.includes("current_user_business_ids()"))
check("it runs when a product is created or its SKU code changed",
  (read("src/features/catalog/actions.ts").match(/await matchIdenticalSkus\(business\.id\)/g) ?? []).length === 2)
check("it runs after every upload, and after a setup sheet is applied",
  read("src/app/api/v1/ledger-files/route.ts").includes("matchIdenticalSkus(business.id)") &&
    body("sku_setup_apply").includes("public.sku_auto_match(p_business_id)"))
check("undo records 'not this product' instead of deleting, so it does not come back",
  read("src/features/catalog/components/unmatch-button.tsx").includes('decision: "REJECTED"'))

/* ---------------------------------------------------------------------------- */
section("2. COSTS BELONG TO THE PRODUCT; HISTORY IS NEVER REWRITTEN")

const apply = body("sku_setup_apply")
check("only an owner or admin can apply a setup sheet", apply.includes("array['OWNER', 'ADMIN']"))
check("a first cost starts on the product's first sale in that currency",
  apply.includes("min((l.posted_at at time zone 'UTC')::date)") && apply.includes("l.product_id = v_cost.product_id") &&
    apply.includes("l.is_cost_line"))
check("a changed cost starts today", apply.includes("-- A different cost: from today.") && apply.includes("v_from := v_today;"))
check("the same cost as in force changes nothing", apply.includes("v_current = v_cost.unit_cost") && apply.includes("continue;"))
check("no cost is ever edited or deleted", !/update public\.product_costs|delete from public\.product_costs/.test(SQL))
check("costs are added once per product and currency", apply.includes("select distinct (v_products ->> (r ->> 'row'))::uuid as product_id"))
check("a sheet with two costs for one Product SKU is refused", apply.includes("having count(distinct (r ->> 'unit_cost')::numeric(20,4)) > 1"))
check("a sheet giving one SKU two products is refused", apply.includes("A SKU is one product."))
check("every product, mapping and cost is audited",
  (apply.match(/write_audit_log/g) ?? []).length >= 3)
check("the ledger, classification and P&L are not touched",
  !/financial_transactions\s+set|insert into public\.(financial_transactions|source_rows|settlements|payouts|classification_rules)|create or replace (view|function) public\.(pnl_|ledger_product_lines|ledger_classified_lines)/.test(SQL))
check("the readers are SECURITY INVOKER; nothing is open to anon",
  body("sku_setup_rows").includes("security invoker") && body("ledger_file_sku_summary").includes("security invoker") &&
    SQL.includes("revoke all on function %s from anon, public"))
check("existing mappings start as MANUAL", SQL.includes("add column method text not null default 'MANUAL'"))

/* ---------------------------------------------------------------------------- */
section("3. CHECKING A FILLED SHEET")

const known = new Set([
  "AMAZON|SG-T84D B Blue Fog FBA",
  "AMAZON|SG-T84D B Blue Fog",
  "NOON|SG-T84D-B-BLUE-FOG",
  "NOON|SG T84D Blue Fog FBA",
  "AMAZON|VT-X521 Rose FBA",
  "AMAZON|SG-T99X Black FBA",
])
const rec = (rowNumber: number, cells: SkuSetupRecord["cells"]): SkuSetupRecord => ({ rowNumber, cells })
const base = { marketplace: "Amazon", currency: "AED" }

const same = checkSkuSetup(
  [
    rec(2, { ...base, rawSku: "SG-T84D B Blue Fog FBA", productSku: "SG-T84D", unitCost: "120" }),
    rec(3, { ...base, rawSku: "SG-T84D B Blue Fog", productSku: "SG-T84D", unitCost: "120.00" }),
    rec(4, { ...base, marketplace: "noon", rawSku: "SG-T84D-B-BLUE-FOG", productSku: "sg t84d", unitCost: "120.0" }),
    rec(5, { ...base, marketplace: "NOON", rawSku: "SG T84D Blue Fog FBA", productSku: "SG-T84D" }),
  ],
  known
)
check("four marketplace SKUs, one Product SKU, one cost: all four rows ready, one product",
  same.rows.length === 4 && same.issues.length === 0 && same.products === 1, JSON.stringify(same.issues))
check("120, 120.00 and 120.0 are the same cost (compared exactly, not converted)", same.issues.length === 0)
check("a row may match a SKU without giving a cost", same.rows.find((r) => r.row === 5)?.unit_cost === null)

const conflict = checkSkuSetup(
  [
    rec(2, { ...base, rawSku: "SG-T84D B Blue Fog FBA", productSku: "SG-T84D", unitCost: "120" }),
    rec(7, { ...base, rawSku: "SG-T84D B Blue Fog", productSku: "SG-T84D", unitCost: "125" }),
    rec(9, { ...base, rawSku: "VT-X521 Rose FBA", productSku: "VT-X521", unitCost: "80" }),
  ],
  known
)
check("different costs for one Product SKU: both rows refused, the others kept",
  conflict.rows.map((r) => r.row).join() === "9" && conflict.issues.length === 2)
check("the message names every conflicting row and cost",
  conflict.issues.every((i) => i.message.includes("rows 2, 7") && i.message.includes("AED 120") && i.message.includes("AED 125")),
  conflict.issues[0]?.message)

const twoProducts = checkSkuSetup(
  [
    rec(2, { ...base, rawSku: "VT-X521 Rose FBA", productSku: "VT-X521" }),
    rec(3, { ...base, rawSku: "VT-X521 Rose FBA", productSku: "VT-X522" }),
  ],
  known
)
check("one marketplace SKU given two products: both rows refused", twoProducts.rows.length === 0 && twoProducts.issues.length === 2)

const mistakes = checkSkuSetup(
  [
    rec(2, { ...base, rawSku: "SG-T99X Black FBA" }),
    rec(3, { ...base, rawSku: "SG-T99X Black FBA", unitCost: "140" }),
    rec(4, { ...base, marketplace: "Etsy", rawSku: "SG-T99X Black FBA", productSku: "SG-T99X" }),
    rec(5, { ...base, rawSku: "NOT-IN-FILES", productSku: "X1" }),
    rec(6, { ...base, rawSku: "SG-T99X Black FBA", productSku: "SG-T99X", unitCost: "12,50" }),
    rec(7, { ...base, rawSku: "SG-T99X Black FBA", productSku: "SG-T99X", unitCost: "AED 12" }),
    rec(8, { ...base, rawSku: "SG-T99X Black FBA", productSku: "SG-T99X", unitCost: "1.23456" }),
    rec(9, { ...base, rawSku: "SG-T99X Black FBA", productSku: "---", unitCost: "1" }),
    rec(10, { marketplace: "Amazon", currency: "", rawSku: "SG-T99X Black FBA", productSku: "SG-T99X", unitCost: "1" }),
  ],
  known
)
check("a row left blank is left for later, silently", mistakes.leftBlank === 1)
check("every mistake is reported on its own row",
  JSON.stringify(mistakes.issues.map((i) => i.rowNumber)) === JSON.stringify([3, 4, 5, 6, 7, 8, 9, 10]),
  JSON.stringify(mistakes.issues))
check("a lower-case currency is accepted as written in capitals",
  checkSkuSetup([rec(2, { ...base, currency: "aed", rawSku: "SG-T99X Black FBA", productSku: "SG-T99X", unitCost: "1" })], known)
    .rows[0]?.currency === "AED")
check("marketplace names are read in any case", marketplaceCodeOf("noon") === "NOON" && marketplaceCodeOf("AMAZON") === "AMAZON" && marketplaceCodeOf("x") === null)

/* ---------------------------------------------------------------------------- */
section("4. THE ONE-SHEET WORKBOOK")

const built = await skuSetupWorkbook([
  { marketplace_code: "AMAZON", account_label: "Amazon.ae", currency: "AED", raw_sku: "SG-T84D B Blue Fog FBA", title: "Blue Fog 24in",
    product_sku: null, product_name: null, unit_cost: null, units_sold: "15.0000", net_sales: "3829.0000" },
  { marketplace_code: "NOON", account_label: "noon UAE", currency: "AED", raw_sku: "=HYPERLINK(1)", title: null,
    product_sku: "SG-T84D", product_name: "SG-T84D", unit_cost: "120.0000", units_sold: "2.0000", net_sales: "-12.5000" },
])
const book = new ExcelJS.Workbook()
await book.xlsx.load(built as unknown as ArrayBuffer)
check("the workbook has ONE sheet", book.worksheets.length === 1)
const sheet = book.worksheets[0]
const heads = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(String)
check("its columns are the owner's, in order",
  heads.map((h) => h.replace(" ✎", "")).join("|") === SKU_SETUP_COLUMNS.map((c) => c.header).join("|"), heads.join("|"))
check("the columns the seller fills are marked", heads.filter((h) => h.endsWith("✎")).length === 3)
check("a SKU a spreadsheet would read as a formula is written as text", sheet.getRow(3).getCell(3).value === "'=HYPERLINK(1)")
check("figures are exact numbers", sheet.getRow(2).getCell(9).value === 3829 && sheet.getRow(3).getCell(6).value === 120)

// The seller fills row 2 and uploads.
sheet.getRow(2).getCell(4).value = "SG-T84D"
sheet.getRow(2).getCell(6).value = 120
const filled = Buffer.from(await book.xlsx.writeBuffer())
const back = await readSkuSetupWorkbook(filled)
check("the filled sheet reads back with Excel's row numbers", back.ok && back.records.map((r) => r.rowNumber).join() === "2,3")
if (back.ok) {
  check("each cell comes back as the seller sees it",
    back.records[0].cells.productSku === "SG-T84D" && back.records[0].cells.unitCost === "120" &&
      back.records[0].cells.marketplace === "Amazon" && back.records[1].cells.rawSku === "=HYPERLINK(1)")
}
const wrong = new ExcelJS.Workbook()
wrong.addWorksheet("x").addRow(["Something", "Else"])
const refused = await readSkuSetupWorkbook(Buffer.from(await wrong.xlsx.writeBuffer()))
check("a different sheet is refused, naming the missing columns", !refused.ok && refused.error.includes("Product SKU"))

/* ---------------------------------------------------------------------------- */
section("5. SCREENS AND WIRING")

const PAGE = read("src/app/(app)/catalog/page.tsx")
const ROW = read("src/features/catalog/components/needs-attention-row.tsx")
const EXCEL = read("src/features/catalog/components/sku-setup-excel.tsx")
const ACTIONS = read("src/features/catalog/setup-actions.ts")
const ROUTE = read("src/app/api/v1/catalog/sku-setup/route.ts")
check("the page has Needs attention, the Excel sheet and the product panel in one place",
  PAGE.includes('id="needs-attention"') && PAGE.includes("<SkuSetupExcel") && PAGE.includes("<ProductPanel") && PAGE.includes("<NeedsAttentionRow"))
check("Save & Match and the sheet both go through sku_setup_apply",
  ACTIONS.includes('rpc("sku_setup_apply"') && ROW.includes("saveAndMatchAction") && EXCEL.includes("applySkuSetupAction"))
check("nothing is applied before the seller has seen the check", EXCEL.includes("previewSkuSetupAction") && EXCEL.includes("onClick={apply}"))
check("the business comes from the session", ACTIONS.includes("getActiveBusiness()") && !/businessId:\s*z\./.test(ACTIONS) && ROUTE.includes("getActiveBusiness()"))
check("no screen calculates money",
  [PAGE, ROW, EXCEL].every((src) => !/\bNumber\(|parseFloat\(|\.toFixed\(/.test(src)))
check("no service-role access", [PAGE, ROW, EXCEL, ACTIONS, ROUTE].every((src) => !/service[_-]?role|createServiceClient/i.test(src)))

/* ---------------------------------------------------------------------------- */
section("6. LARGE CATALOGUES (0046)")

const FAST = read("supabase/migrations/0046_fast_sku_readers.sql")
const QUERIES = read("src/features/catalog/queries.ts")
check("the dashboard no longer builds the whole SKU queue to count it",
  !/sku_mapping_queue\(p_business_id\)/.test(FAST.slice(0, FAST.indexOf("-- 2. sku_mapping_queue"))) &&
    FAST.includes("and l.posted_at >= p_from and l.posted_at < p_to"))
check("the SKU readers skip the per-line product and cost lookups", !/is_cost_line|from public\.ledger_product_lines/.test(FAST))
check("SKU lists are read in pages, never cut off at 1,000 rows",
  QUERIES.includes(".range(from, to)") && QUERIES.includes("const PAGE = 1000"))
const QUEUE = read("supabase/migrations/0047_sku_queue_by_line_type.sql")
const VIEW = read("supabase/migrations/0035_product_master_cogs.sql")
const priority = (text: string) =>
  text.slice(text.indexOf("order by case"), text.indexOf("limit 1", text.indexOf("order by case"))).replace(/\s+/g, " ")
check("the SKU queue classifies each line type once, with the ledger view's own rule priority",
  QUEUE.includes("group by a.marketplace_code, a.label, ft.currency, ft.raw_sku, b.format_id") &&
    priority(QUEUE) === priority(VIEW.slice(VIEW.indexOf("create or replace view public.ledger_classified_lines"))) &&
    QUEUE.includes("and (cr.business_id is null or cr.business_id = p_business_id)"))
const SUGGEST = read("supabase/migrations/0048_sku_suggestions_once.sql")
check("suggestions normalise each known SKU once and are still never applied",
  SUGGEST.includes("keys as (") && (SUGGEST.match(/sku_normalize\(u\.raw_sku\)/g) ?? []).length === 1 &&
    SUGGEST.includes("k.marketplace_code <> u.marketplace_code") && SUGGEST.includes("r.status = 'REJECTED'") &&
    !/insert into|update public\./.test(SUGGEST))
check("the setup counts come from SQL over every SKU", QUERIES.includes('rpc("sku_setup_summary"') && PAGE.includes("getSkuSummary("))

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
