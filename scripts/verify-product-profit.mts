/**
 * The Product profitability screens: grouping, ranking, sentences and wiring.
 *
 * Run with:  npm run test:product-profit
 *
 * Offline: no database, no network. The figures come from pnl_by_product() and
 * are tested against the real database elsewhere (test:catalog-ledger); this
 * proves what the screens DO with them: group by comparing, order by
 * comparing, count, and never add, subtract or convert.
 */

import { readFileSync } from "node:fs"

import {
  HIGH_MARGIN_FROM,
  LOW_MARGIN_BELOW,
  attentionOf,
  biggestLeaks,
  buildProfitRows,
  FILTER_CHIPS,
  FILTER_LABEL,
  filterCounts,
  insightsOf,
  matchesFilter,
  statusOf,
  topProfitable,
  type ProfitRow,
} from "../src/services/catalog/product-profit-view"

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

let counter = 0
function row(overrides: Partial<ProfitRow> = {}): ProfitRow {
  counter += 1
  return {
    currency: "AED",
    row_kind: "PRODUCT",
    product_id: `p${counter}`,
    product_name: `Product ${counter}`,
    product_category: "Luggage",
    raw_sku: null,
    marketplace_code: null,
    lines: 3,
    units_sold: "10.0000",
    net_sales: "1000.0000",
    other_income: "0.0000",
    costs: "-200.0000",
    cogs: "-500.0000",
    contribution: "800.0000",
    gross_profit: "300.0000",
    gross_margin_percent: "30.0",
    cogs_status: "COSTED",
    ...overrides,
  }
}
const margin = (value: string | null, gp = "10.0000") => row({ gross_margin_percent: value, gross_profit: gp })

/* ---------------------------------------------------------------------------- */
section("1. WHICH GROUP A PRODUCT IS IN")

check(`the lines are ${LOW_MARGIN_BELOW}% and ${HIGH_MARGIN_FROM}%`, LOW_MARGIN_BELOW === "5" && HIGH_MARGIN_FROM === "25")
check("a negative margin is a loss", statusOf(margin("-0.5")) === "LOSS")
check("exactly zero is low margin, not a loss (breakeven is not a loss)", statusOf(margin("0")) === "LOW_MARGIN")
check("just under 5% is low margin", statusOf(margin("4.9")) === "LOW_MARGIN")
check("exactly 5% is good (the line is inclusive on the good side)", statusOf(margin("5.0")) === "GOOD")
check("just under 25% is good", statusOf(margin("24.9")) === "GOOD")
check("exactly 25% is high margin", statusOf(margin("25.0")) === "HIGH_MARGIN")
check("decimals are compared as digits: 9.5 is below 10, though '9.5' > '10' as text", statusOf(margin("9.5")) === "GOOD")
check("a product with no final cost is missing cost, whatever its margin says",
  statusOf(row({ cogs_status: "NO_COST", gross_margin_percent: "40.0" })) === "MISSING_COST" &&
    statusOf(row({ cogs_status: "PARTLY_COSTED", gross_margin_percent: "40.0" })) === "MISSING_COST")
check("an unmatched SKU needs mapping", statusOf(row({ row_kind: "UNMAPPED_SKU", product_id: null, raw_sku: "X1", cogs_status: "NO_PRODUCT" })) === "NEEDS_MAPPING")
check("the lines no product owns are not a product at all", statusOf(row({ row_kind: "NOT_ALLOCATED" })) === null)
check("costed but all refunded (no margin to state): a negative profit is a loss, otherwise good",
  statusOf(row({ gross_margin_percent: null, gross_profit: "-12.0000" })) === "LOSS" &&
    statusOf(row({ gross_margin_percent: null, gross_profit: "0.0000" })) === "GOOD")

/* ---------------------------------------------------------------------------- */
section("2. THE ROWS THE SCREEN SHOWS")

const set: ProfitRow[] = [
  row({ product_id: "a", product_name: "Alpha", net_sales: "9000.0000", gross_profit: "2250.0000", gross_margin_percent: "25.0" }),
  row({ product_id: "b", product_name: "Beta", net_sales: "800.0000", gross_profit: "-40.0000", gross_margin_percent: "-5.0" }),
  row({ product_id: "c", product_name: "Gamma", net_sales: "700.0000", gross_profit: "20.0000", gross_margin_percent: "2.8" }),
  row({ product_id: "d", product_name: "Delta", net_sales: "600.0000", gross_profit: "100.0000", gross_margin_percent: "16.0" }),
  row({ product_id: "e", product_name: "Epsilon", net_sales: "500.0000", cogs_status: "NO_COST", cogs: null, gross_profit: null, gross_margin_percent: null }),
  row({ row_kind: "UNMAPPED_SKU", product_id: null, product_name: null, product_category: null, raw_sku: "SG-1", marketplace_code: "NOON", net_sales: "400.0000", cogs_status: "NO_PRODUCT", cogs: null, gross_profit: null, gross_margin_percent: null }),
  row({ row_kind: "NOT_ALLOCATED", product_id: null, product_name: null, net_sales: "0.0000", contribution: "-300.0000", gross_profit: "-300.0000", gross_margin_percent: null, cogs_status: "NOT_APPLICABLE" }),
]
const items = buildProfitRows(set, new Map([["a", "ALP-1"], ["d", null]]))

check("the not-allocated line is kept out of the product list", items.length === 6 && !items.some((i) => i.name.includes("Not allocated")))
check("a product shows its own SKU; a product without one shows none", items.find((i) => i.name === "Alpha")?.sku === "ALP-1" && items.find((i) => i.name === "Delta")?.sku === null)
check("an unmatched SKU is shown by its marketplace SKU and marketplace", items.find((i) => i.kind === "UNMAPPED_SKU")?.name === "SG-1" && items.find((i) => i.kind === "UNMAPPED_SKU")?.marketplace === "NOON")
check("figures pass through as the exact text they arrived as",
  items.find((i) => i.name === "Alpha")?.netSales === "9000.0000" && items.find((i) => i.name === "Beta")?.grossProfit === "-40.0000")
check("'high sales' is the top fifth by net sales, at least one (6 rows -> 2)",
  items.filter((i) => i.highSales).length === 2 && items.find((i) => i.name === "Alpha")?.highSales === true && items.find((i) => i.name === "Beta")?.highSales === true)
check("a single product is still 'high sales'", buildProfitRows([row()], new Map()).every((i) => i.highSales))

const counts = filterCounts(items)
check("counts: all 6, loss 1, low margin 1, high margin 1, needs setup 2 (one missing cost + one needs mapping), profitable 3",
  counts.all === 6 && counts.loss === 1 && counts.low === 1 && counts.high === 1 && counts.setup === 2 && counts.profitable === 3,
  JSON.stringify(counts))
check("needs setup is a missing cost plus an unmatched SKU, never a finished product",
  items.filter((i) => matchesFilter(i, "setup")).every((i) => ["MISSING_COST", "NEEDS_MAPPING"].includes(i.status)))
check("profitable is low margin + good + high margin, never a loss or an unfinished product",
  items.filter((i) => matchesFilter(i, "profitable")).every((i) => ["LOW_MARGIN", "GOOD", "HIGH_MARGIN"].includes(i.status)))
check("the chips are exactly All, Loss-making, Low margin, High margin, Needs setup (the owner's list)",
  FILTER_CHIPS.map((k) => FILTER_LABEL[k].replace(/ \(.*\)$/, "")).join(" > ") === "All products > Loss-making > Low margin > High margin > Needs setup",
  FILTER_CHIPS.map((k) => FILTER_LABEL[k]).join(" > "))

/* ---------------------------------------------------------------------------- */
section("3. RANKING AND WORDS")

const top = topProfitable(items)
check("top profitable: only products that made money, largest first (2250, 100, 20)",
  top.map((i) => i.name).join(",") === "Alpha,Delta,Gamma", top.map((i) => i.name).join(","))
const leaks = biggestLeaks(items)
check("biggest leaks: losses and thin margins, the biggest loss first", leaks.map((i) => i.name).join(",") === "Beta,Gamma", leaks.map((i) => i.name).join(","))
check("a product with no final profit is never ranked", ![...top, ...leaks].some((i) => i.grossProfit === null))
const exact = buildProfitRows(
  [row({ product_name: "Small", gross_profit: "9.5000", gross_margin_percent: "30" }), row({ product_name: "Large", gross_profit: "10.0000", gross_margin_percent: "30" })],
  new Map()
)
check("ranking compares the digits: 10.0000 outranks 9.5000 (as text '9.5000' would win)", topProfitable(exact)[0]?.name === "Large")

const attention = attentionOf(items)
check("attention: 2 need it (1 loss + 1 low margin), both high-selling or not as ranked; 1 missing cost, 1 unmatched",
  attention.needAttention === 2 && attention.loss === 1 && attention.missingCost === 1 && attention.needsMapping === 1 && attention.lowMarginHighSales === 1,
  JSON.stringify(attention))

const recommendations = [...new Set(items.map((i) => i.recommendation))]
check("every recommendation is a fixed sentence with no figure in it", recommendations.length === 6 && recommendations.every((text) => !/\d/.test(text)))
check("no recommendation tells anyone to change a price automatically or promises a number",
  recommendations.every((text) => !/\bAED\b|\bSAR\b|%|automatic/i.test(text)))
const actions = new Map(items.map((i) => [i.status, i.action]))
check("a loss and a low margin are sent to the product", actions.get("LOSS")?.href === "/catalog/products/b" && actions.get("LOW_MARGIN")?.label === "Review product")
check("a missing cost goes to where the cost is added; an unmatched SKU to where it is matched",
  actions.get("MISSING_COST")?.label === "Add cost" && actions.get("NEEDS_MAPPING")?.href === "/catalog#needs-attention")

const money = (v: string) => `AED ${v}`
const percent = (v: string) => `${v}%`
const insights = insightsOf(items, money, percent)
check("insights name the worst loss from its own row, and the best product from its own row",
  insights.some((i) => i.tone === "danger" && i.body.includes("Beta") && i.body.includes("AED -40.0000")) &&
    insights.some((i) => i.tone === "success" && i.title.includes("Alpha") && i.body.includes("AED 2250.0000")))
check("insights add nothing up: every figure quoted is one that is already in a row",
  insights.every((i) => (i.body.match(/-?\d+\.\d{4}/g) ?? []).every((figure) => set.some((r) => [r.gross_profit, r.net_sales, r.contribution].includes(figure)))))
check("a clean set has nothing to flag", insightsOf(buildProfitRows([margin("30")], new Map()), money, percent).every((i) => i.tone === "success"))

/* ---------------------------------------------------------------------------- */
section("4. NO ARITHMETIC ON MONEY, AND THE WIRING")

const files = [
  "src/services/catalog/product-profit-view.ts",
  "src/features/catalog/components/product-profit/product-table.tsx",
  "src/features/catalog/components/product-profit/ranked-card.tsx",
  "src/features/catalog/components/product-profit/insights-card.tsx",
  "src/features/catalog/components/product-profit/attention-banner.tsx",
  "src/app/(app)/ledger/products/page.tsx",
  "src/features/catalog/components/product-profit/product-profit-body.tsx",
  "src/features/catalog/components/product-profit/summary-strip.tsx",
  "src/features/catalog/components/product-profit/margin-chip.tsx",
  "src/features/overview/components/products-table.tsx",
]
for (const file of files) {
  const source = read(file)
  check(`${file}: no money is converted to a JavaScript number`, !/\b(Number|parseFloat|parseInt)\(/.test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")))
}
const view = read("src/services/catalog/product-profit-view.ts")
check("ordering uses compareMoney", /compareMoney/.test(view) && !/\.sort\(\(a, b\) => (Number|a\.\w+ - b\.\w+)/.test(view))

const page = read("src/app/(app)/ledger/products/page.tsx")
check("the page is titled Product profitability and links the existing export",
  /title: "Product profitability"/.test(page) && /api\/v1\/reports\/product-profit/.test(page))
check("the page shows the attention banner, both ranked lists, insights and the table (through the shared body)",
  /<ProductProfitBody/.test(page) &&
    (() => {
      const body = read("src/features/catalog/components/product-profit/product-profit-body.tsx")
      return /<AttentionBanner/.test(body) && (body.match(/<RankedCard/g) ?? []).length === 2 && /<InsightsCard/.test(body) && /<ProductTable/.test(body) && /<SummaryStrip/.test(body)
    })())
check("the lines no product owns stay visible below the table", /Not allocated to a product/.test(read("src/features/catalog/components/product-profit/product-profit-body.tsx")))
check("the panel is called Insights, not AI: no model writes it", /Insights/.test(read("src/features/catalog/components/product-profit/insights-card.tsx")) && !/>\s*AI insights/.test(read("src/features/catalog/components/product-profit/insights-card.tsx")))
check("there is no product-photo claim: the placeholder says so", /no product images/i.test(read("src/features/catalog/components/product-profit/product-thumb.tsx")))
const table = read("src/features/catalog/components/product-profit/product-table.tsx")
check("search, filter chips, sorting and paging are all real controls",
  /type="search"/.test(table) && /aria-pressed/.test(table) && /aria-sort/.test(table) && /PAGE_SIZE/.test(table))
check("phones get a card layout, not only a wide table", /md:hidden/.test(table) && /hidden overflow-hidden/.test(table))

const headings = [...table.slice(table.indexOf("<thead"), table.indexOf("</thead>")).matchAll(/header\("\w+", "([^"]+)"|>(Status|Action)</g)].map((m) => m[1] ?? m[2])
check("the columns run Product, Units, Net sales, Gross profit, Margin, Marketplace costs, COGS, Status, Action (the owner's order)",
  headings.join(" > ") === "Product > Units > Net sales > Gross profit > Margin > Marketplace costs > COGS > Status > Action", headings.join(" > "))
check("healthy products stay quiet: only loss, low-margin, missing-cost and unmatched rows get a sentence",
  /NEEDS_WORDS = new Set<ProfitStatus>\(\["LOSS", "LOW_MARGIN", "MISSING_COST", "NEEDS_MAPPING"\]\)/.test(table) && /NEEDS_WORDS\.has\(row\.status\)/.test(table))
check("loss and low-margin rows are tinted and edged; the colour is backed by a pill and a sign",
  /bg-danger-subtle\/40/.test(table) && /border-l-danger/.test(table) && /border-l-warning/.test(table) && /<StatusPill/.test(table))
check("the health bar's segment widths are whole-number product counts, not money", /flexGrow: byStatus\[status\]/.test(table))
check("a margin is a chip tinted by its group, a dash when it does not exist", /MarginChip/.test(table) && /return <span className="text-muted-foreground">—<\/span>/.test(read("src/features/catalog/components/product-profit/margin-chip.tsx")))
check("the ranked lists fit their own card width instead of clipping", /@container/.test(read("src/features/catalog/components/product-profit/ranked-card.tsx")) && !/min-w-\[26rem\]/.test(read("src/features/catalog/components/product-profit/ranked-card.tsx")))
check("the page cannot be stretched wider than the screen by the table", /grid-cols-\[minmax\(0,1fr\)\]/.test(page))
const strip = read("src/features/catalog/components/product-profit/summary-strip.tsx")
check("the totals strip shows the SQL summary's own figures, with Final or Incomplete, and adds nothing up",
  /StatusLabel/.test(strip) && !/\+|reduce\(/.test(strip.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/className="[^"]*"/g, "").replace(/<\/?\w+/g, "")))
check("the page passes the totals straight from the P&L summary", /netSales: summary\.net_sales/.test(page) && /grossProfitBefore: summary\.gross_profit_before_open_items/.test(page))

const dashboard = read("src/app/(app)/overview/page.tsx")
check("the dashboard card is no longer cut to the top five sellers before it groups them", !/\.slice\(0, 5\)/.test(dashboard.slice(dashboard.indexOf("const topProducts"), dashboard.indexOf("const topProducts") + 700)))
check("the dashboard card uses the same grouping rules as the page", /statusOf/.test(read("src/features/overview/components/products-table.tsx")))

console.log(`\n${"=".repeat(74)}\n RESULT: ${passed} passed, ${failed} failed\n${"=".repeat(74)}`)
process.exit(failed === 0 ? 0 : 1)
