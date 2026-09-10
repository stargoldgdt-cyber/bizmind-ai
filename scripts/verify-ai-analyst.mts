/**
 * The AI analyst: the rules that must hold with no model involved.
 *
 * Run with:  npm run test:ai
 *
 * The whole of Phase 8 rests on one claim -- that BizMind will not show an
 * owner a figure a language model made up. A prompt asking nicely is not that
 * claim. These tests are.
 *
 * Nothing here calls OpenAI. The key is unset before anything is imported, so
 * a test that accidentally reached the network would fail rather than quietly
 * spend money.
 */

// Before importing anything that might read it.
delete process.env.OPENAI_API_KEY

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { explainMetric, explainPeriod } from "../src/services/ai/analyst"
import { isAiConfigured } from "../src/services/ai/client"
import { buildFactSheet, renderFactSheet, type FactSheetInput } from "../src/services/ai/facts"
import {
  buildAllowlist,
  claimsToAct,
  claimsToCalculate,
  extractNumbers,
  guardNumbers,
  normalise,
} from "../src/services/ai/guard"
import { narrativeSystemPrompt } from "../src/services/ai/prompts"
import type { BusinessHealth } from "../src/services/analytics/health"
import type { Insight } from "../src/services/analytics/insights"
import type {
  ChannelPerformance,
  Financials,
  MetricComparison,
  ProductPerformance,
} from "../src/services/analytics/types"

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

/* -------------------------------------------------------------------------- */
/* A realistic period to narrate                                              */
/* -------------------------------------------------------------------------- */

const FINANCIALS: Financials = {
  revenue: "9550.5000",
  cogs: "3800.0000",
  fees: "852.0400",
  gross_profit: "4898.4600",
  gross_margin: "51.29",
  expenses: "1200.0000",
  net_profit: "3698.4600",
  net_margin: "38.72",
  orders_count: 8,
  units_sold: "14.0000",
  avg_order_value: "1193.8125",
  customers_count: 6,
  refunds: "0.0000",
  returns_count: 0,
  cancelled_orders: 1,
  items_total: 4,
  items_with_cost: 3,
  cost_coverage: "75.00",
  orders_zero_fees: 1,
  orders_without_channel: 2,
  line_revenue: "8900.0000",
  orders_fees_unknown: 3,
  fee_coverage: "62.50",
  cost_gap: "25.00",
  fee_gap: "37.50",
  refund_rate: "0.00",
}

const COMPARISONS: MetricComparison[] = [
  {
    metric: "revenue",
    current_value: "9550.5000",
    previous_value: "8100.0000",
    absolute_change: "1450.5000",
    percent_change: "17.90",
    direction: "up",
  },
  {
    metric: "gross_profit",
    current_value: "4898.4600",
    previous_value: "5210.0000",
    absolute_change: "-311.5400",
    percent_change: "-5.98",
    direction: "down",
  },
]

const CHANNELS: ChannelPerformance[] = [
  {
    channel_id: "c1",
    channel_name: "Amazon",
    channel_type: "AMAZON",
    revenue: "6200.0000",
    cogs: "2900.0000",
    fees: "744.0000",
    gross_profit: "2556.0000",
    gross_margin: "41.23",
    orders_count: 5,
    units_sold: "9.0000",
    avg_order_value: "1240.0000",
    items_total: 3,
    items_with_cost: 2,
    cost_coverage: "66.67",
    orders_fees_unknown: 1,
    fee_coverage: "80.00",
  },
]

const PRODUCTS: ProductPerformance[] = [
  {
    sku: "W-2001",
    product_name: "Widget Pro",
    revenue: "5100.0000",
    units_sold: "6.0000",
    cogs: "2400.0000",
    fees_allocated: "612.0000",
    gross_profit: "2088.0000",
    gross_margin: "40.94",
    orders_count: 4,
    items_total: 2,
    items_with_cost: 2,
    cost_coverage: "100.00",
  },
]

const HEALTH: BusinessHealth = {
  score: 62,
  status: "watch",
  dimensionsScored: 4,
  dimensionsTotal: 6,
  summary: "Growing, but the margin is under pressure.",
  dimensions: [
    {
      key: "profitability",
      label: "Profitability",
      score: 55,
      status: "watch",
      reason: "Gross margin is 51.29%, but a quarter of order lines have no cost.",
      confidence: "low",
      supporting: [],
    },
    {
      key: "inventory",
      label: "Inventory",
      score: null,
      status: "unknown",
      reason: "no stock levels have been recorded",
      confidence: "low",
      supporting: [],
    },
  ],
}

const INSIGHTS: Insight[] = [
  {
    type: "margin_falling_while_revenue_rises",
    severity: "warning",
    title: "Revenue rose but gross profit fell",
    summary: "Sales are up 17.90% while gross profit is down 5.98%.",
    supportingMetrics: [
      { label: "Revenue", value: "AED 9,550.50", format: "money" },
      { label: "Gross profit", value: "AED 4,898.46", format: "money" },
    ],
    businessImpact: "You are selling more and keeping less of it.",
    recommendedNextStep: "Check channel fees on Amazon before increasing spend.",
  },
]

const INPUT: FactSheetInput = {
  businessName: "Alpha Trading Co",
  currency: "AED",
  periodLabel: "Last 30 days",
  comparisonLabel: "the previous 30 days",
  periodIncomplete: false,
  current: FINANCIALS,
  comparisons: COMPARISONS,
  channels: CHANNELS,
  products: PRODUCTS,
  health: HEALTH,
  insights: INSIGHTS,
}

const SHEET = buildFactSheet(INPUT)
const SHEET_TEXT = renderFactSheet(SHEET)

/* -------------------------------------------------------------------------- */
section("1. THE FACT SHEET IS THE ONLY THING THE MODEL SEES")

check(
  "it carries the figures, formatted exactly as the dashboard shows them",
  SHEET_TEXT.includes("AED 9,550.50") && SHEET_TEXT.includes("AED 4,898.46")
)
check("and the currency, stated once and plainly", SHEET_TEXT.includes("CURRENCY: AED"))
check("and the period", SHEET_TEXT.includes("Last 30 days"))

check(
  "it carries the DEFINITION of each figure, so the explanation can be checked",
  SHEET_TEXT.includes("means: Revenue minus cost of goods minus channel fees.")
)

check(
  "IT NAMES THE UNRELIABLE FIGURES: missing costs",
  SHEET_TEXT.includes("order lines have no recorded cost") &&
    SHEET_TEXT.includes("overstated")
)
check(
  "and missing fees, as unknown rather than zero",
  SHEET_TEXT.includes("orders have no fee recorded") &&
    SHEET_TEXT.includes("unknown, not zero")
)

check(
  "a figure the database could not calculate says so rather than being absent",
  renderFactSheet(
    buildFactSheet({
      ...INPUT,
      current: { ...FINANCIALS, cost_coverage: null, items_total: 0, items_with_cost: 0 },
    })
  ).includes("not calculated")
)

check(
  "an unscored health dimension says why, instead of scoring zero",
  SHEET_TEXT.includes("not scored (no stock levels have been recorded)")
)

check(
  "the deterministic findings are included and marked as already established",
  SHEET_TEXT.includes("Findings BizMind has already established") &&
    SHEET_TEXT.includes("Revenue rose but gross profit fell")
)

// The lesson from measuring this against a real model. Given only "cost
// coverage 75%", it wrote "25% of order lines have no cost" in five replies
// out of eight -- correct arithmetic, and exactly what must never happen.
// Adding an instruction not to changed nothing (3/8 before, 3/8 after).
// Supplying the gap as its own SQL-computed figure took it to 8/8.
//
// The rule the rest of the product runs on, applied here: if an explanation
// needs a number, COMPUTE IT. Do not ask the model more firmly not to.
check(
  "THE GAP IS SUPPLIED, so no explanation ever needs to derive it",
  SHEET_TEXT.includes("Share of order lines with NO recorded cost: 25.0%") &&
    SHEET_TEXT.includes("Share of orders with NO recorded fee: 37.5%")
)
check(
  "and a reply quoting the gap passes the guard",
  guardNumbers(
    "Cost coverage is 75.0%, so 25.0% of your order lines have no recorded cost.",
    SHEET_TEXT
  ).ok
)
check(
  "a gap the database could not calculate says so, rather than reading as zero",
  renderFactSheet(
    buildFactSheet({
      ...INPUT,
      current: { ...FINANCIALS, cost_gap: null, fee_gap: null },
    })
  ).includes("Share of order lines with NO recorded cost: not calculated")
)

// The point of the whole design: there is nothing to add up.
check(
  "IT CONTAINS NO RAW DATA -- no order ids, no line items, nothing to compute from",
  !SHEET_TEXT.includes("order_id") &&
    !SHEET_TEXT.includes("external_id") &&
    !SHEET_TEXT.includes("unit_cost")
)

/* -------------------------------------------------------------------------- */
section("2. THE NUMBER GUARD ACCEPTS WHAT IT GAVE")

const good =
  "Revenue reached AED 9,550.50, up 17.90% on the previous 30 days. " +
  "Gross profit fell to AED 4,898.46 even so."

check("a reply using only supplied figures passes", guardNumbers(good, SHEET_TEXT).ok)

check(
  "a rounded figure passes -- 51.3% for 51.29% is readable, not invented",
  guardNumbers("Your margin is about 51.3%.", SHEET_TEXT).ok
)
check(
  "a truncated figure passes too",
  guardNumbers("Your margin is roughly 51%.", SHEET_TEXT).ok
)
check(
  "grouping separators do not matter",
  guardNumbers("Revenue was 9550.50 this period.", SHEET_TEXT).ok
)
check(
  "counts that were supplied pass",
  guardNumbers("All 8 orders are included, from 6 customers.", SHEET_TEXT).ok
)
check(
  "a reply with no numbers at all passes",
  guardNumbers("Your margin is under pressure. Look at fees first.", SHEET_TEXT).ok
)

/* -------------------------------------------------------------------------- */
section("3. AND REFUSES WHAT IT DID NOT")

// The failure this whole phase exists to prevent. The figure is plausible,
// the sentence is well written, and the number is fiction.
const invented = "Revenue reached AED 9,550.50, leaving you a net profit of AED 4,102.88."
const inventedResult = guardNumbers(invented, SHEET_TEXT)

check("A PLAUSIBLE INVENTED PROFIT IS CAUGHT", !inventedResult.ok)
check(
  "and the invented figure is named, so it can be logged",
  !inventedResult.ok && inventedResult.invented.includes("4102.88"),
  !inventedResult.ok ? inventedResult.invented.join(", ") : ""
)

check(
  "a subtraction the model performed itself is caught",
  // 9550.50 - 3800.00 = 5750.50. Correct arithmetic, still refused: BizMind's
  // figures come from the database, and a model that computes one today will
  // compute a wrong one tomorrow.
  !guardNumbers("Revenue less cost of goods leaves AED 5,750.50.", SHEET_TEXT).ok
)

check(
  "an invented percentage is caught",
  !guardNumbers("Fees are eating 8.9% of your revenue.", SHEET_TEXT).ok
)

check(
  "an invented count is caught",
  !guardNumbers("You have 47 active products.", SHEET_TEXT).ok
)

// The honest limit of this approach, asserted rather than left as folklore.
// A small integer that appears anywhere in the sheet is allowed anywhere in
// the reply, so "top 3 channels" passes because 3 orders have no recorded fee.
// That is a tolerable hole: it admits a stray count, never a money figure or a
// percentage, because those do not collide by accident.
check(
  "KNOWN LIMIT: a small integer that appears elsewhere in the facts is allowed",
  guardNumbers("Your top 3 channels are performing well.", SHEET_TEXT).ok
)
check(
  "but an invented MONEY figure never collides by accident",
  !guardNumbers("That leaves AED 4,102.88.", SHEET_TEXT).ok
)

check(
  "a year that was never supplied is caught",
  !guardNumbers("This is your best month since 2024.", SHEET_TEXT).ok
)

check(
  "several inventions are all reported, not just the first",
  (() => {
    const result = guardNumbers("You made 4,102.88 on 22 orders.", SHEET_TEXT)
    return !result.ok && result.invented.length === 2
  })()
)

/* -------------------------------------------------------------------------- */
section("4. THE GUARD'S OWN MACHINERY")

check("numbers are found inside prose", extractNumbers("up 17.90% to AED 9,550.50").length === 2)
check("grouping is stripped", normalise("9,550.50") === "9550.5")
check("trailing zeros are stripped", normalise("9550.5000") === "9550.5")
check("a whole number stays whole", normalise("8") === "8")
check("leading zeros go", normalise("008") === "8")
check("a bare decimal point is handled", normalise("51.00") === "51")

check(
  "0 and 1 are always allowed -- they appear in ordinary English",
  buildAllowlist("").has("0") && buildAllowlist("").has("1")
)
check(
  "but 2 is not, unless it was supplied",
  !buildAllowlist("").has("2")
)

check(
  "the allowlist is built from the sheet we actually sent",
  buildAllowlist(SHEET_TEXT).has("9550.5") && buildAllowlist(SHEET_TEXT).has("17.9")
)

/* -------------------------------------------------------------------------- */
section("5. TWO OTHER WAYS TO LOSE TRUST")

check(
  "a reply claiming to have calculated something is refused",
  claimsToCalculate("I calculated your margin from the figures.") &&
    claimsToCalculate("Adding these up gives a healthy total.") &&
    claimsToCalculate("which works out to a strong month")
)
check(
  "ordinary prose is not caught by that",
  !claimsToCalculate("Your margin fell because fees rose.")
)

check(
  "a reply claiming to have acted is refused",
  claimsToAct("I have updated your product costs.") &&
    claimsToAct("I've sent a reminder to the supplier.")
)
check(
  "so is regulated advice",
  claimsToAct("You should invest the surplus.") &&
    claimsToAct("This will reduce your tax liability.")
)
check(
  "but an ordinary recommendation is fine",
  !claimsToAct("Record the missing costs before you judge this margin.")
)

/* -------------------------------------------------------------------------- */
section("6. IT DEGRADES SAFELY")

check("with no key, the layer reports itself unconfigured", !isAiConfigured())

const noKey = await explainPeriod(INPUT)
check("and explaining a period does not throw", noKey.ok === false)
check(
  "it returns a reason instead",
  !noKey.ok && noKey.reason === "not_configured",
  !noKey.ok ? noKey.reason : ""
)
check(
  "with a message that reassures the owner about the figures themselves",
  !noKey.ok && noKey.message.includes("figures above are unaffected")
)

const noKeyMetric = await explainMetric("Gross margin", INPUT)
check("the same holds for explaining one figure", !noKeyMetric.ok)

// A 429 from OpenAI means two opposite things, and the advice that follows is
// opposite too: "wait" clears one and never clears the other. Getting this
// wrong sends an owner off to wait for something that will not happen.
const clientSource = readFileSync("src/services/ai/client.ts", "utf8")
check(
  "an out-of-credit 429 is told apart from a real rate limit",
  clientSource.includes("insufficient_quota") && clientSource.includes('"no_credit"')
)

const analystSource = readFileSync("src/services/ai/analyst.ts", "utf8")
check(
  "and running out of credit says so, rather than 'try again shortly'",
  /no_credit:[\s\S]{0,200}run out of credit/.test(analystSource)
)
check(
  "while a real rate limit is the one that says to try again",
  /rate_limited:[\s\S]{0,200}Try again shortly/.test(analystSource)
)

// Every reason must have a message, or a suppressed explanation would render
// as the word "undefined" on the dashboard.
const reasons = [
  "not_configured", "no_credit", "rate_limited", "timed_out", "refused",
  "failed", "invented_figures", "claimed_to_calculate", "out_of_scope",
]
check(
  "every possible reason has an owner-facing message",
  reasons.every((reason) => analystSource.includes(`  ${reason}:`)),
  reasons.filter((reason) => !analystSource.includes(`  ${reason}:`)).join(", ")
)
check(
  "and every one of them reassures the owner about the figures",
  (analystSource.match(/figures above are unaffected/g) ?? []).length === reasons.length,
  String((analystSource.match(/figures above are unaffected/g) ?? []).length)
)

/* -------------------------------------------------------------------------- */
section("6b. THE MODEL IS CHOSEN IN ONE PLACE, AND WE CHECK WHO ANSWERED")

const clientText = readFileSync("src/services/ai/client.ts", "utf8")

check(
  "the default model is gpt-5.6-terra",
  clientText.includes('const DEFAULT_MODEL = "gpt-5.6-terra"'),
)
check(
  "and gpt-4o-mini is no longer referenced anywhere",
  !readdirSync("src/services/ai")
    .map((f) => readFileSync(join("src/services/ai", f), "utf8"))
    .some((contents) => contents.includes("gpt-4o-mini"))
)
check(
  "the model is selected in exactly one expression",
  (clientText.match(/DEFAULT_MODEL/g) ?? []).length === 2,
  String((clientText.match(/DEFAULT_MODEL/g) ?? []).length)
)
check(
  "an operator can still override it without a code change",
  clientText.includes("process.env.OPENAI_MODEL")
)

// A working key proves nothing about which model replied. A provider may serve
// a different or dated build than the alias asked for, and every explanation
// would then be written by a model nobody chose.
check(
  "the model reported back is read from the RESPONSE, not echoed from the request",
  clientText.includes("respondingModel(json)") &&
    /function respondingModel/.test(clientText)
)

// Newer models accept only their own default temperature and reject anything
// else outright. Sending a value BizMind does not need would tie the product
// to one generation of model -- which is exactly what happened on the first
// attempt at this change.
check(
  "temperature is omitted unless a caller explicitly asks for one",
  clientText.includes("request.temperature === undefined")
)
check(
  "so no fixed temperature is hard-coded into the request",
  !/temperature:\s*(0|0\.\d+)/.test(clientText)
)

/* -------------------------------------------------------------------------- */
section("7. THE PROMPT SAYS THE SAME THING THE CODE ENFORCES")

// The prompt is hard-wrapped for reading, so a sentence can span lines.
// Compare against a whitespace-collapsed copy rather than the raw text.
const system = narrativeSystemPrompt().replace(/\s+/g, " ")
check("it forbids stating a number that was not supplied", system.includes("NEVER state a number"))
check("it forbids calculating", system.includes("NEVER calculate"))
check("it forbids claiming to have calculated", system.includes("NEVER describe yourself"))
check(
  "it requires unreliable figures to be called unreliable",
  system.includes("unreliable") && system.includes("overstated")
)
check(
  "it forbids treating a missing figure as zero",
  system.includes("Do not treat it as zero")
)
check("it forbids regulated advice and claiming to act", system.includes("does not act"))

/* -------------------------------------------------------------------------- */
section("8. ONE DOOR, AND ONLY ONE")

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full)
  }
  return out
}

const sourceFiles = walk("src")
const aiLayer = (file: string) => file.replace(/\\/g, "/").includes("src/services/ai/")

const callsOpenAi = sourceFiles.filter((file) => {
  const contents = readFileSync(file, "utf8")
  return contents.includes("api.openai.com") || /from ["']openai["']/.test(contents)
})

check(
  "OpenAI is reached from exactly one file in the whole codebase",
  callsOpenAi.length === 1,
  callsOpenAi.join(", ")
)
check(
  "and that file is the AI client",
  callsOpenAi.every((file) => file.replace(/\\/g, "/").endsWith("src/services/ai/client.ts"))
)

const readsKey = sourceFiles.filter((file) =>
  readFileSync(file, "utf8").includes("OPENAI_API_KEY")
)
check(
  "the API key is read in one place, and it is inside the AI layer",
  readsKey.length === 1 && aiLayer(readsKey[0]),
  readsKey.join(", ")
)

check(
  "no NEXT_PUBLIC_ variable carries an OpenAI key, so it can never reach a browser",
  !sourceFiles.some((file) =>
    /NEXT_PUBLIC_[A-Z_]*OPENAI/.test(readFileSync(file, "utf8"))
  )
)

// A client component importing the analyst would bundle server code, and the
// "server-only" guard exists to make that a build error rather than a leak.
const analyst = readFileSync("src/services/ai/analyst.ts", "utf8")
const client = readFileSync("src/services/ai/client.ts", "utf8")
check(
  "the AI modules are marked server-only",
  analyst.includes('import "server-only"') && client.includes('import "server-only"')
)

// Every reply must pass through narrate(). A feature calling complete()
// directly would skip the guard entirely.
const analystCalls = (analyst.match(/complete\(/g) ?? []).length
check(
  "every feature goes through the one checked path, so none can skip the guard",
  analystCalls === 1,
  `${analystCalls} direct calls`
)

const featureFiles = sourceFiles.filter((file) => !aiLayer(file))

/**
 * Comments and strings removed before the check.
 *
 * This failed once on PROSE: a comment in the integration security layer cited
 * `src/services/ai/client.ts` as the precedent for confining a key to one
 * file. Citing the rule is not breaking it, and a guard that cannot tell the
 * difference teaches people to stop writing the citation.
 */
function withoutProse(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ")
}

const IMPORTS_AI_CLIENT = /(?:import|require).*services\/ai\/client/

const rawClientImporters = featureFiles.filter((file) =>
  IMPORTS_AI_CLIENT.test(withoutProse(readFileSync(file, "utf8")))
)

check(
  "nothing outside the AI layer imports the raw client",
  rawClientImporters.length === 0,
  rawClientImporters.join(", ")
)

/* -------------------------------------------------------------------------- */
section("9. NO FINANCIAL ARITHMETIC ENTERED THE AI LAYER")

// A money value must never be converted to a JavaScript number here. Coverage
// percentages may be compared against a threshold -- that is judgement over a
// ratio the database already computed, which CLAUDE.md permits and health.ts
// already does. The lookbehind matters: `formatNumber(` is a display call and
// ends in the same six letters.
const MONEY_FIELDS = /(revenue|gross_profit|net_profit|cogs|fees|expenses|refunds|avg_order_value)/i

for (const file of ["facts.ts", "analyst.ts", "guard.ts", "prompts.ts", "client.ts"]) {
  const contents = readFileSync(join("src/services/ai", file), "utf8")

  const conversions = [...contents.matchAll(/(?<![A-Za-z])Number\(([^)]*)\)/g)].map(
    (match) => match[1]
  )
  const onMoney = conversions.filter((argument) => MONEY_FIELDS.test(argument))

  check(`${file} never converts a money figure to a number`, onMoney.length === 0,
    onMoney.join(" | "))
}

check(
  "the only subtraction in the fact sheet is on counts, not money",
  (() => {
    const contents = readFileSync("src/services/ai/facts.ts", "utf8")
    const subtractions = [...contents.matchAll(/current\.(\w+)\s*-\s*current\.(\w+)/g)]
    return subtractions.every(
      ([, left, right]) => !MONEY_FIELDS.test(left) && !MONEY_FIELDS.test(right)
    )
  })()
)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
