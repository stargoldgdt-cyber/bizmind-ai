/**
 * The product analysis page (reached from "Review product" / "Review price").
 *
 * Checks the rules and the shape contract with SQL, not the database: the
 * figures come from product_analysis() (migration 0070) and are checked live
 * by scripts/verify-product-analysis-live.mts once the migration is applied.
 *
 *   npm run test:product-analysis
 */
import { readFileSync } from "node:fs"

import {
  TARGET_MARGINS,
  parseProductAnalysis,
  parseTargetMargin,
  type ProductAnalysis,
} from "../src/services/catalog/product-analysis"
import { buildInsights, priorityOf } from "../src/services/catalog/product-analysis-view"
import { statusOfFigures } from "../src/services/catalog/product-profit-view"

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

const period = (over: Record<string, unknown> = {}) => ({
  units: "24.0000",
  net_sales: "1872.9000",
  costs: "-505.2800",
  cogs: "-1510.0000",
  gross_profit: "-142.3800",
  margin: "-7.6",
  costs_pct: 27,
  cogs_pct: 80.6,
  cogs_status: "COSTED",
  lines: 40,
  ...over,
})

function document(over: Record<string, unknown> = {}) {
  return {
    currency: "AED",
    current: period(),
    previous: period({ net_sales: "1672.0000" }),
    changes: { net_sales_pct: 12, units_pct: 9, gross_profit_pct: -18, margin_points: -4.2 },
    months: [
      { month: "2026-07-01", has_lines: true, units: "20.0000", net_sales: "1672.0000", costs: "-400.0000", gross_profit: "-120.0000", margin: "-7.2", net_sales_y: 800, gross_profit_y: 300, zero_y: 280 },
      { month: "2026-08-01", has_lines: true, units: "24.0000", net_sales: "1872.9000", costs: "-504.6000", gross_profit: null, margin: null, net_sales_y: 900, gross_profit_y: null, zero_y: 280 },
    ],
    marketplaces: [
      { account_id: "a1", account_label: "Amazon.ae", marketplace_code: "AMAZON", units: "12.0000", net_sales: "980.0000", costs: "-165.2000", cogs: "-650.0000", gross_profit: "164.8000", margin: "16.8" },
      { account_id: "a2", account_label: "Carrefour", marketplace_code: "CARREFOUR", units: "4.0000", net_sales: "332.9000", costs: "-148.8000", cogs: "-290.0000", gross_profit: "-105.9000", margin: "-31.8" },
    ],
    costs: [{ category: "MARKETPLACE_FEE", label: "Marketplace fees", lines: 20, total: "-504.6000", pct_of_net_sales: 26.9, pct_of_costs: 100, bar: 1000 }],
    costs_total: "-504.6000",
    price: {
      target_margin: 15,
      average_price: "78.0375",
      unit_cogs: "62.9167",
      unit_costs: "21.0533",
      break_even_price: "83.9700",
      required_price: "98.7882",
      increase_amount: "20.7507",
      increase_pct: 26.6,
    },
    orders: [{ order_ref: "AMZ-1", marketplace_code: "AMAZON", posted_at: "2026-08-28T10:00:00Z", units: "1.0000", net_sales: "82.0000", profit: "12.4000" }],
    ...over,
  }
}

/* ---------------------------------------------------------------------------- */
section("1. THE SHAPE OF WHAT SQL RETURNS")

const parsed: ProductAnalysis = parseProductAnalysis(document())
check("a complete document parses", parsed.currency === "AED" && parsed.months.length === 2)
check("money stays exact text, untouched", parsed.current?.net_sales === "1872.9000" && parsed.price?.required_price === "98.7882")
check("an unexpected shape fails loudly instead of rendering blanks", (() => {
  try {
    parseProductAnalysis({ ...document(), months: "nope" })
    return false
  } catch {
    return true
  }
})())
check("a product with no sales parses (current is null)", parseProductAnalysis(document({ current: null, previous: null, changes: null, price: null })).current === null)
check("a month with no cost has no gross profit and no chart position", parsed.months[1].gross_profit === null && parsed.months[1].gross_profit_y === null)
check("target margins are a fixed list; anything else falls back to 15",
  parseTargetMargin("20") === 20 && parseTargetMargin("37") === 15 && parseTargetMargin(undefined) === 15 && parseTargetMargin("abc") === 15 && TARGET_MARGINS.length === 5)

/* ---------------------------------------------------------------------------- */
section("2. STATUS, PRIORITY AND WORDS")

check("the page's status uses the table's own thresholds",
  statusOfFigures({ cogsStatus: "COSTED", margin: "-7.6", grossProfit: "-142.38" }) === "LOSS" &&
    statusOfFigures({ cogsStatus: "COSTED", margin: "3.0", grossProfit: "10" }) === "LOW_MARGIN" &&
    statusOfFigures({ cogsStatus: "COSTED", margin: "25.0", grossProfit: "10" }) === "HIGH_MARGIN" &&
    statusOfFigures({ cogsStatus: "NO_COST", margin: null, grossProfit: null }) === "MISSING_COST")
check("priority: loss is high, thin or unfinished is medium, healthy is low",
  priorityOf("LOSS") === "High" && priorityOf("LOW_MARGIN") === "Medium" && priorityOf("MISSING_COST") === "Medium" && priorityOf("GOOD") === "Low")

const loss = buildInsights(parsed, "LOSS")
check("a loss says so and carries the product's own figures", loss.headline === "This product is losing money." && /AED/.test(loss.summary) && /1,872\.90/.test(loss.summary))
check("the reasons are the cost shares from SQL, largest first, and the below-break-even fact first of all",
  loss.reasons[0]?.key === "price" && loss.reasons[1]?.key === "cogs" && loss.reasons[2]?.key === "fees", loss.reasons.map((r) => r.key).join(","))
check("a high product cost is called out; its figure is the one SQL gave", loss.reasons.find((r) => r.key === "cogs")?.title === "Product cost is high" && /80\.6%/.test(loss.reasons.find((r) => r.key === "cogs")!.detail))
check("the price action quotes SQL's own increase and states its assumption",
  /20\.75/.test(loss.actions.find((a) => a.key === "price")?.detail ?? "") && /stay the same/.test(loss.actions.find((a) => a.key === "price")?.detail ?? ""))
check("it points at the cost when that is the bigger share", loss.actions.some((a) => a.key === "cost"))
check("it compares marketplaces by margin, best first",
  /16\.8%.*Amazon.*-31\.8%.*Carrefour/.test(loss.actions.find((a) => a.key === "marketplaces")?.detail ?? ""), loss.actions.map((a) => a.detail).join(" | "))
check("there is no advertising advice: advertising is never allocated to a product",
  !JSON.stringify(loss).toLowerCase().includes("ad spend") && !loss.actions.some((a) => /advert/i.test(a.title)))

const healthy = buildInsights(parseProductAnalysis(document({ current: period({ margin: "30.0", gross_profit: "500.0000" }), marketplaces: [] })), "HIGH_MARGIN")
check("a healthy product is told to keep going, not to fix anything", healthy.actions.length === 1 && healthy.actions[0].key === "keep")
const unfinished = buildInsights(parseProductAnalysis(document({ current: period({ cogs: null, gross_profit: null, margin: null, cogs_pct: null, cogs_status: "NO_COST" }), price: null })), "MISSING_COST")
check("an incomplete product shows no profit figure and asks for the cost",
  /needs the product's cost/i.test(unfinished.summary) && unfinished.actions.some((a) => a.key === "add-cost") && !/gross profit of/.test(unfinished.summary))
check("no sales: the page says so instead of inventing a verdict",
  buildInsights(parseProductAnalysis(document({ current: null })), "GOOD").headline === "No sales for this product in this period.")

/* ---------------------------------------------------------------------------- */
section("3. THE PAGE ONLY DRAWS WHAT SQL GAVE IT")

const files = [
  "src/app/(app)/ledger/products/[id]/page.tsx",
  "src/services/catalog/product-analysis.ts",
  "src/services/catalog/product-analysis-view.ts",
  ...["insights-panel", "marketplace-table", "orders-table", "price-check", "trend-chart"].map((f) => `src/features/catalog/components/product-analysis/${f}.tsx`),
]
// Comments may name what the page leaves out; only the code is checked.
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const code = files.map((file) => strip(read(file))).join("\n")
check("no Number()/parseFloat on a figure anywhere in the page's code", !/\b(Number|parseFloat|parseInt)\(/.test(code.replace(/parseTargetMargin[^\n]*\n/g, "")), "found one")
check("the migration is read-only and invoker-rights",
  /security invoker/.test(read("supabase/migrations/0070_product_analysis.sql")) && !/\b(insert|update|delete)\b\s+(into|public)/i.test(read("supabase/migrations/0070_product_analysis.sql").replace(/--[^\n]*/g, "")))
check("no AI is involved: the page imports no model code and calls its panel Insights", !/openai/i.test(code) && /Insights and recommendation/.test(read("src/features/catalog/components/product-analysis/insights-panel.tsx")))
check("the page shows nothing the data does not hold (no stock, photo, dimensions)", !/inventory|stock on hand|weight|dimensions/i.test(strip(read(files[0]))))
check("the trend draws on one axis: positions come from SQL, there is no second scale", !/dual|secondary axis|right axis/i.test(strip(read("src/features/catalog/components/product-analysis/trend-chart.tsx"))))

console.log(`\n${"=".repeat(74)}\n RESULT: ${passed} passed, ${failed} failed\n${"=".repeat(74)}`)
if (failed > 0) process.exit(1)
