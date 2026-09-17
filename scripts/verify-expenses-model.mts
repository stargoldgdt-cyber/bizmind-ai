/**
 * Operating expenses, Net Profit and Sheets dataset targets, offline (GCC Phase 7).
 *
 * Run with:  npm run test:expenses   (part of npm run verify)
 *
 * Proves, without a database, that:
 *   - a product-master or product-cost tab is read by the upload's own checks,
 *     with every dated cost of one SKU kept together and nothing rounded
 *   - the new tab types reach the right worker-only writers, and nothing else
 *   - migration 0037 classifies expenses without guessing, keeps Net Profit
 *     incomplete while anything is unknown, and widens every sync gate
 *   - the screens and menu are wired and never calculate
 */

import { readFileSync } from "node:fs"

import { NAVIGATION } from "../src/config/navigation"
import { ExactNumber } from "../src/lib/json-exact"
import { SHEET_ENTITIES, SHEET_ENTITY_KEYS, ENTITY_LIST, importEntityLabel } from "../src/services/ingestion/entities"
import type { NormalizedCatalogProduct, NormalizedProductCosts } from "../src/services/ingestion/contracts"
import { prepareTabularPage, readSheetSettings } from "../src/services/integrations/sync/tabular"

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
const MIGRATION = read("supabase/migrations/0037_expenses_net_profit_datasets.sql")
const ENUMS = read("supabase/migrations/0036_dataset_import_entities.sql")

/* -------------------------------------------------------------------------- */
section("1. WHAT A SHEET TAB CAN HOLD")

check("a tab can hold the five kinds", SHEET_ENTITY_KEYS.join(",") === "ORDERS,PRODUCTS,EXPENSES,CATALOG,PRODUCT_COSTS")
check("a one-off upload still offers only the legacy three", ENTITY_LIST.map((e) => e.key).join(",") === "ORDERS,PRODUCTS,EXPENSES")
check("labels read as the owner would say them",
  importEntityLabel("PRODUCT_COSTS") === "Product costs" && importEntityLabel("CATALOG") === "Product master" &&
    importEntityLabel("EXPENSES") === "Expenses")
check("a cost tab needs SKU and cost; the date is recommended with its consequence",
  SHEET_ENTITIES.PRODUCT_COSTS.fields.filter((f) => f.importance === "required").map((f) => f.key).join(",") === "sku,unit_cost" &&
    (SHEET_ENTITIES.PRODUCT_COSTS.fields.find((f) => f.key === "effective_from")?.consequence ?? "").includes("incomplete"))

/* -------------------------------------------------------------------------- */
section("2. A PRODUCT-COST PAGE")

const costMeta = {
  entity: "PRODUCT_COSTS",
  mapping: { sku: "SKU", unit_cost: "Cost", effective_from: "From", currency: "Currency" },
  date_format: "YMD",
  decimal_separator: ".",
}
const costSettings = readSheetSettings(costMeta, ["SKU", "Cost", "From", "Currency"])
check("the cost tab's choices are accepted", costSettings.ok, JSON.stringify(costSettings))
const missingIdentity = readSheetSettings({ ...costMeta, mapping: { unit_cost: "Cost" } }, ["Cost"])
check("a cost tab without a SKU column is refused", !missingIdentity.ok)

if (costSettings.ok) {
  const page = prepareTabularPage({
    settings: costSettings.settings,
    businessCurrency: "AED",
    records: [
      { SKU: "SKU-1", Cost: new ExactNumber("30"), From: "2026-07-01" },
      { SKU: "SKU-1", Cost: "35.50", From: "2026-08-01" },
      { SKU: "SKU-1", Cost: "12", From: "2026-07-01", Currency: "sar" },
      { SKU: "SKU-2", Cost: "5" },
      { SKU: "SKU-3", Cost: "1.23456", From: "2026-07-01" },
      { SKU: "SKU-4", Cost: "-2" },
      { SKU: "SKU-5", Cost: "3", Currency: "dirham" },
      { SKU: "", Cost: "3" },
    ],
    rowNumbers: [2, 3, 4, 5, 6, 7, 8, 9],
  })
  const byKey = new Map(page.records.map((r) => [r.key, r]))
  const one = byKey.get("SKU-1")?.row as NormalizedProductCosts | null | undefined
  check(
    "every dated cost of one SKU is one record, in a stable order, currencies kept apart",
    JSON.stringify(one?.costs) === JSON.stringify([
      { currency: "AED", unit_cost: "30", effective_from: "2026-07-01" },
      { currency: "AED", unit_cost: "35.50", effective_from: "2026-08-01" },
      { currency: "SAR", unit_cost: "12", effective_from: "2026-07-01" },
    ]),
    JSON.stringify(one)
  )
  const two = byKey.get("SKU-2")?.row as NormalizedProductCosts | null | undefined
  check("an undated cost is kept as undated, in the business currency",
    JSON.stringify(two?.costs) === JSON.stringify([{ currency: "AED", unit_cost: "5", effective_from: null }]))
  check("a cost with 5 decimals is refused, not rounded", byKey.get("SKU-3")?.row === null &&
    page.issues.some((i) => i.key === "SKU-3" && i.issue.message.includes("never rounds")))
  check("a negative cost is refused", byKey.get("SKU-4")?.row === null)
  check("a currency that is not a code is refused", byKey.get("SKU-5")?.row === null)
  check("a row without a SKU is reported and skipped", page.unkeyedRows === 1)
  check("the same costs fingerprint the same", prepareTabularPage({
    settings: costSettings.settings, businessCurrency: "AED",
    records: [{ SKU: "SKU-1", Cost: "35.50", From: "2026-08-01" }, { SKU: "SKU-1", Cost: new ExactNumber("30"), From: "2026-07-01" },
      { SKU: "SKU-1", Cost: "12", From: "2026-07-01", Currency: "SAR" }],
    rowNumbers: [2, 3, 4],
  }).records[0]?.hash === byKey.get("SKU-1")?.hash)
}

/* -------------------------------------------------------------------------- */
section("3. A PRODUCT-MASTER PAGE")

const catSettings = readSheetSettings(
  { entity: "CATALOG", mapping: { sku: "Code", name: "Name", brand: "Brand" }, date_format: "auto", decimal_separator: "." },
  ["Code", "Name", "Brand"]
)
check("the product tab's choices are accepted", catSettings.ok)
if (catSettings.ok) {
  const page = prepareTabularPage({
    settings: catSettings.settings,
    businessCurrency: "AED",
    records: [
      { Code: "A-1", Name: "Bottle", Brand: "Invented" },
      { Code: "A-2", Name: "" },
      { Code: "A-3", Name: "x".repeat(201) },
    ],
    rowNumbers: [2, 3, 4],
  })
  const a1 = page.records.find((r) => r.key === "A-1")?.row as NormalizedCatalogProduct | null | undefined
  check("a product row becomes name, SKU, category and brand only",
    JSON.stringify(a1) === JSON.stringify({ sku: "A-1", name: "Bottle", category: null, brand: "Invented" }), JSON.stringify(a1))
  check("a product without a name, or with a name too long, is refused",
    page.records.find((r) => r.key === "A-2")?.row === null && page.records.find((r) => r.key === "A-3")?.row === null)
}

/* -------------------------------------------------------------------------- */
section("4. THE WORKER AND THE TRUSTED DOOR")

const WORKER = read("src/services/integrations/sync/worker.ts")
const PRIVILEGED = read("src/services/integrations/security/privileged.ts")
check("a CATALOG tab is written by sync_apply_catalog", WORKER.includes('if (resource === "CATALOG") return "sync_apply_catalog"'))
check("a PRODUCT_COSTS tab is written by sync_apply_product_costs",
  WORKER.includes('if (resource === "PRODUCT_COSTS") return "sync_apply_product_costs"'))
check("both writers, and nothing else new, are on the trusted list",
  PRIVILEGED.includes('"sync_apply_catalog",') && PRIVILEGED.includes('"sync_apply_product_costs",') &&
    !PRIVILEGED.includes("expense_category_classify") && !PRIVILEGED.includes("sync_dataset_batch"))

/* -------------------------------------------------------------------------- */
section("5. MIGRATIONS 0036 AND 0037")

check("0036 only adds the two enum values", ENUMS.includes("add value if not exists 'CATALOG'") &&
  ENUMS.includes("add value if not exists 'PRODUCT_COSTS'") && !/create (table|function)/.test(ENUMS))
check("16 expense categories in three cost classes", (MIGRATION.match(/^ {2}\('[A-Z_]+', '[^']+', '(OPERATING|ADVERTISING|NOT_PROFIT)', /gm) ?? []).length === 16)
const seed = MIGRATION.slice(MIGRATION.indexOf("from (values"), MIGRATION.indexOf(") as seed (k, c);"))
for (const ambiguous of ["advertising", "marketing", "other", "miscellaneous", "freight", "shipping", "ads", "customs"]) {
  check(`"${ambiguous}" is left for the owner, never guessed`, !seed.includes(`('${ambiguous}',`))
}
check("stock purchases and marketplace charges are kept out of profit",
  seed.includes("('stock purchase', 'STOCK_PURCHASES')") && seed.includes("('amazon fees', 'MARKETPLACE_CHARGES')"))
check("the business's own rule wins over BizMind's", MIGRATION.includes("order by (cr.business_id is null)"))
check("a rule is retired, never edited or deleted", MIGRATION.includes("An expense category rule cannot be edited") &&
  MIGRATION.includes("An expense category rule cannot be deleted"))
check("net profit is NULL while gross profit is incomplete or an expense is unplaced",
  MIGRATION.includes("when j.gross_profit is null or j.unclassified_lines > 0 then null"))
check("a month with no marketplace figures is named, never final", MIGRATION.includes("'NO_MARKETPLACE_DATA'"))
check("net profit counts operating and outside advertising only",
  MIGRATION.includes("(j.gross_profit::numeric + j.operating + j.advertising)::numeric(20,4)::text"))
check("a changed synced cost is withdrawn and replaced", MIGRATION.includes("retire_reason = 'Changed in the Google Sheet'"))
check("a sync never archives or deletes a product",
  !/update public\.catalog_products[\s\S]{0,80}status/.test(MIGRATION) && !MIGRATION.includes("delete from public.catalog_products"))
check("a dataset sync batch cannot be withdrawn", MIGRATION.includes("A product or cost sync cannot be withdrawn"))
for (const gate of ["sync_record_state_commit", "sync_record_issues", "sync_reconcile_due"]) {
  const start = MIGRATION.indexOf(`create or replace function public.${gate}(`)
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start))
  check(`${gate} is widened for both datasets`, start > 0 &&
    body.includes("('ORDERS', 'PRODUCTS', 'EXPENSES', 'CATALOG', 'PRODUCT_COSTS')"))
}
for (const writer of ["expense_category_classify", "expense_category_rule_retire"]) {
  const start = MIGRATION.indexOf(`create function public.${writer}(`)
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n$$;", start))
  check(`${writer}: definer, owner/admin only, audited`,
    start > 0 && body.includes("security definer") && body.includes("array['OWNER', 'ADMIN']") && body.includes("write_audit_log"))
}
check("the dataset writers are granted to the worker only",
  /'public\.sync_apply_catalog\(uuid, jsonb\)',[\s\S]*?grant execute on function %s to service_role/.test(MIGRATION))
check("no new table stores a person's identity", !/email|phone|address|customer|buyer/i.test(
  MIGRATION.slice(MIGRATION.indexOf("create table public.expense_categories"), MIGRATION.indexOf("-- 2. Expenses, classified"))
))

/* -------------------------------------------------------------------------- */
section("6. SCREENS AND MENU")

const items = NAVIGATION.flatMap((s) => s.items)
check("the menu has Operating expenses", items.some((i) => i.href === "/ledger/expenses" && i.enabled))
const PAGE = read("src/app/(app)/ledger/expenses/page.tsx")
const OVERVIEW = read("src/app/(app)/ledger/page.tsx")
const ACTIONS = read("src/features/expenses/actions.ts")
for (const [name, source] of [["expenses", PAGE], ["overview", OVERVIEW]] as const) {
  check(`${name}: no service-role access, no arithmetic on money`,
    !/service[_-]?role/i.test(source) && !/\bNumber\(|parseFloat\(|\.toFixed\(/.test(source))
}
check("the overview shows net profit only when the engine gives one", OVERVIEW.includes("const final = net.net_profit !== null"))
check("net profit is shown for a whole currency, never one account among several",
  OVERVIEW.includes("byCurrency.get(account.currency)?.length === 1"))
check("expense actions take the business from the session and use the audited functions",
  ACTIONS.includes("getActiveBusiness()") && ACTIONS.includes('rpc("expense_category_classify"') &&
    ACTIONS.includes('rpc("expense_category_rule_retire"') && !/\.from\(/.test(ACTIONS))

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
