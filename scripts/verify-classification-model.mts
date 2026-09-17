/**
 * The classification model, offline (migration 0032).
 *
 * Run with:  npm run test:classification   (part of npm run verify)
 *
 * Proves, without a database, that:
 *   - the model is internally consistent (types, treatments, figures)
 *   - the TypeScript mirror and the migration seed the same 24 categories
 *   - every Amazon code the importer knows is classified, identically in
 *     TypeScript and in the migration, and nothing else is
 *   - the line match key is built the same way in TypeScript and SQL
 *   - the P&L engine adds each figure from the categories it should
 */

import { readFileSync } from "node:fs"

import {
  CLASSIFICATION_CATEGORIES,
  FINANCIAL_TYPES,
  METRIC_GROUPS,
  PNL_TREATMENTS,
  classificationMatchKey,
} from "../src/services/classification/model"
import { AMAZON_V2_CLASSIFICATION } from "../src/services/marketplaces/amazon/classification"
import { AMAZON_V2_RULES, amazonMatchKey } from "../src/services/marketplaces/amazon/flat-file-v2"

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

const sql = readFileSync("supabase/migrations/0032_classification_pnl_engine.sql", "utf8").replace(/\r\n/g, "\n")

/* -------------------------------------------------------------------------- */
section("1. THE MODEL IS CONSISTENT")

const codes = CLASSIFICATION_CATEGORIES.map((c) => c.code)
check("24 categories", CLASSIFICATION_CATEGORIES.length === 24, String(CLASSIFICATION_CATEGORIES.length))
check("every code is unique", new Set(codes).size === codes.length)
check(
  "every type, treatment and figure is one the model defines",
  CLASSIFICATION_CATEGORIES.every(
    (c) =>
      (FINANCIAL_TYPES as readonly string[]).includes(c.financialType) &&
      (PNL_TREATMENTS as readonly string[]).includes(c.defaultTreatment) &&
      (METRIC_GROUPS as readonly string[]).includes(c.metricGroup)
  )
)

const fits = (type: string, treatment: string) =>
  (type === "REVENUE" && ["INCREASE_REVENUE", "DECREASE_REVENUE"].includes(treatment)) ||
  (type === "EXPENSE" && treatment === "INCREASE_EXPENSE") ||
  (type === "TAX" && ["CONDITIONAL", "NO_PNL_IMPACT"].includes(treatment)) ||
  (["CASH", "MEMO"].includes(type) && treatment === "NO_PNL_IMPACT")
check(
  "every treatment fits its financial type",
  CLASSIFICATION_CATEGORIES.every((c) => fits(c.financialType, c.defaultTreatment))
)
check(
  "only Input VAT is conditional -- decided by the account's VAT setting (B1)",
  CLASSIFICATION_CATEGORIES.filter((c) => c.defaultTreatment === "CONDITIONAL").map((c) => c.code).join() === "INPUT_VAT"
)
check(
  "non-recoverable VAT is a treatment, not a category",
  !CLASSIFICATION_CATEGORIES.some((c) => /NON_RECOVERABLE/i.test(c.code))
)
check(
  "gross sales is product sales + shipping income, nothing else",
  CLASSIFICATION_CATEGORIES.filter((c) => c.metricGroup === "GROSS_SALES").map((c) => c.code).join() ===
    "PRODUCT_SALES,SHIPPING_INCOME"
)
check(
  "refunds and seller discounts decrease revenue; they are not expenses",
  CLASSIFICATION_CATEGORIES.filter((c) => c.defaultTreatment === "DECREASE_REVENUE").map((c) => c.code).join() ===
    "SALES_REFUNDS,SELLER_DISCOUNTS"
)
check(
  "payouts, reserves and transfers are cash with no P&L impact",
  CLASSIFICATION_CATEGORIES.filter((c) => c.financialType === "CASH").every((c) => c.defaultTreatment === "NO_PNL_IMPACT")
)
check(
  "report totals and results are memo cross-checks",
  ["REPORT_TOTAL", "REPORT_RESULT"].every((code) =>
    CLASSIFICATION_CATEGORIES.some((c) => c.code === code && c.financialType === "MEMO" && c.defaultTreatment === "NO_PNL_IMPACT")
  )
)

/* -------------------------------------------------------------------------- */
section("2. THE MIGRATION SEEDS THE SAME CATEGORIES")

const sqlCategories = [
  ...sql.matchAll(/\('([A-Z_]+)', '(REVENUE|EXPENSE|TAX|CASH|MEMO)', '([^']+)', '([A-Z_]+)', '([A-Z_]+)', (\d+)\)/g),
]
  // The migration's self-check deliberately tries to insert an invalid category.
  .filter((m) => m[1] !== "SELF_CHECK")
  .map((m) => `${m[1]}|${m[2]}|${m[3]}|${m[4]}|${m[5]}|${m[6]}`)
const tsCategories = CLASSIFICATION_CATEGORIES.map(
  (c) => `${c.code}|${c.financialType}|${c.label}|${c.defaultTreatment}|${c.metricGroup}|${c.sortOrder}`
)
check("the migration seeds 24 categories", sqlCategories.length === 24, String(sqlCategories.length))
check(
  "identical code, type, label, treatment, figure and order",
  JSON.stringify([...sqlCategories].sort()) === JSON.stringify([...tsCategories].sort()),
  tsCategories.filter((c) => !sqlCategories.includes(c)).join(" ; ")
)

/* -------------------------------------------------------------------------- */
section("3. EVERY AMAZON CODE IS CLASSIFIED, ONCE, THE SAME EVERYWHERE")

const importKeys = AMAZON_V2_RULES.map((r) => r.matchKey).sort()
const classKeys = AMAZON_V2_CLASSIFICATION.map((r) => r.matchKey).sort()
check("21 Amazon codes classified", classKeys.length === 21, String(classKeys.length))
check("no code classified twice", new Set(classKeys).size === classKeys.length)
check(
  "exactly the codes the importer knows",
  JSON.stringify(classKeys) === JSON.stringify(importKeys),
  importKeys.filter((k) => !classKeys.includes(k)).join(", ")
)
check(
  "every Amazon classification uses a category of the model",
  AMAZON_V2_CLASSIFICATION.every((r) => (codes as readonly string[]).includes(r.category))
)

const sqlRules = [...sql.matchAll(/\('([^'|]+\|[^']+)', '([A-Z_]+)', '([^']+)', '[^']*'\)/g)].map(
  (m) => `${m[1]}|${m[2]}|${m[3]}`
)
const tsRules = AMAZON_V2_CLASSIFICATION.map((r) => `${r.matchKey}|${r.category}|${r.subcategory}`)
check("the migration seeds 21 Amazon rules", sqlRules.length === 21, String(sqlRules.length))
check(
  "identical code, category and subcategory in TypeScript and SQL",
  JSON.stringify([...sqlRules].sort()) === JSON.stringify([...tsRules].sort()),
  tsRules.filter((r) => !sqlRules.includes(r)).join(" ; ")
)

const category = (key: string) => AMAZON_V2_CLASSIFICATION.find((r) => r.matchKey === key)?.category
check("Commission -> Marketplace Fee", category("Order|ItemFees|Commission") === "MARKETPLACE_FEE")
check("a commission reversal keeps its category", category("Refund|ItemFees|Commission") === "MARKETPLACE_FEE")
check("FBA per-unit fee -> Fulfillment", category("Order|ItemFees|FBAPerUnitFulfillmentFee") === "FULFILLMENT")
check("Cost of Advertising -> Advertising", category("ServiceFee|Cost of Advertising|TransactionTotalAmount") === "ADVERTISING")
check("Principal -> Product Sales", category("Order|ItemPrice|Principal") === "PRODUCT_SALES")
check("Refund Principal -> Sales Refunds (revenue down, not an expense)", category("Refund|ItemPrice|Principal") === "SALES_REFUNDS")
check("Tax on fee -> Input VAT", category("AmazonFees|Premium Services Fee|Tax on fee") === "INPUT_VAT")
check("SP 360 -> Marketplace Fee", category("AmazonFees|Premium Services Fee|Base fee") === "MARKETPLACE_FEE")
check("COD charge -> Other Income, COD fee -> Payment Fee",
  category("Order|ItemPrice|COD") === "OTHER_INCOME" && category("Order|ItemFees|CODFee") === "PAYMENT_FEE")
check("storage -> Storage", category("FBAFees|FBA Inventory Storage Fee|Base fee") === "STORAGE")

/* -------------------------------------------------------------------------- */
section("4. A LINE IS MATCHED THE SAME WAY IN TYPESCRIPT AND SQL")

check(
  "the model's key equals the importer's key for every Amazon code",
  AMAZON_V2_RULES.every((r) => {
    const [t, a, d] = r.matchKey.split("|")
    return classificationMatchKey(t || null, a || null, d || null) === amazonMatchKey(t, a, d)
  })
)
check("a blank part is an empty string, never 'null'", classificationMatchKey("Order", null, "Principal") === "Order||Principal")
check(
  "the SQL function joins the same three parts with the same separator",
  sql.includes("coalesce(p_source_type, '') || '|' || coalesce(p_source_subtype, '') || '|'") &&
    sql.includes("|| coalesce(p_source_description, '')")
)

/* -------------------------------------------------------------------------- */
section("5. THE ENGINE ADDS EACH FIGURE FROM THE RIGHT PLACE")

const summary = sql.slice(sql.indexOf("create function public.pnl_summary"), sql.indexOf("create function public.pnl_breakdown"))
for (const group of ["GROSS_SALES", "SALES_REFUNDS", "SELLER_DISCOUNTS", "OTHER_INCOME", "MARKETPLACE_FEES",
  "FULFILLMENT", "ADVERTISING", "OTHER_MARKETPLACE_COSTS", "OUTPUT_VAT"]) {
  check(`a figure sums metric group ${group}`, summary.includes(`s.metric_group = '${group}'`))
}
check(
  "net sales = gross sales + refunds + seller discounts (signed)",
  summary.includes("(j.gross_sales + j.sales_refunds + j.seller_discounts)")
)
check(
  "contribution counts only lines whose treatment affects profit",
  summary.includes("('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')")
)
check(
  "contribution is NULL unless final",
  summary.includes("case when j.contribution_incomplete then null else j.pnl_known")
)
check(
  "unknown lines, unresolved VAT and unreadable rows make contribution incomplete",
  summary.includes("(t.unknown_lines > 0 or coalesce(e.n, 0) > 0 or t.conditional_lines > 0)")
)
check(
  "the VAT setting resolves Input VAT: Recoverable -> no impact, Non-recoverable -> expense",
  sql.includes("when tp.input_vat_treatment = 'RECOVERABLE' then 'NO_PNL_IMPACT'") &&
    sql.includes("when tp.input_vat_treatment = 'NON_RECOVERABLE' then 'INCREASE_EXPENSE'")
)
check(
  "a HIGH BizMind rule outranks a business's own, which outranks a MEDIUM rule",
  sql.includes("when cr.business_id is null and cr.confidence = 'HIGH' then 1") &&
    sql.includes("when cr.business_id is not null then 2")
)
check(
  "every reader runs with the caller's rights",
  ["pnl_summary", "pnl_breakdown", "ledger_data_quality", "classification_rule_impact"].every((fn) => {
    const start = sql.indexOf(`create function public.${fn}`)
    const body = sql.slice(start, sql.indexOf("$$;", start))
    return body.includes("security invoker") && !body.includes("security definer")
  })
)
check(
  "a business may classify only a code BizMind does not classify",
  sql.includes("BizMind already classifies this marketplace code")
)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

process.exit(failed === 0 ? 0 : 1)
