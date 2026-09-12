/**
 * Deterministic tests for analytics logic that needs no database.
 *
 * Run with:  npm run test:analytics
 *
 * Period boundaries, health scoring bands and insight rules. These are the
 * parts where a mistake produces a confident, wrong statement about someone's
 * business, so every band and every rule is asserted rather than assumed.
 */

import {
  byMoneyDescending,
  compareMoney,
  isPositiveMoney,
  isZeroMoney,
} from "../src/services/analytics/money"
import { calculateHealth } from "@/services/analytics/health"
import { generateInsights } from "@/services/analytics/insights"
import { resolveCustomPeriod, resolvePeriod } from "@/services/analytics/periods"
import type {
  ChannelPerformance,
  Financials,
  HealthInputs,
  MetricComparison,
  ProductPerformance,
} from "@/services/analytics/types"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

/* -------------------------------------------------------------------------- */
section("1. PERIODS — boundaries never overlap and never leave a gap")

const now = new Date("2026-06-15T14:30:00.000Z")

const p7 = resolvePeriod("7d", now)
check("7d ends now", p7.to === now.toISOString())
check(
  "7d previous window ends exactly where the current one starts",
  p7.previousTo === p7.from,
  `${p7.previousTo} vs ${p7.from}`
)
check(
  "7d windows are the same length",
  new Date(p7.to).getTime() - new Date(p7.from).getTime() ===
    new Date(p7.previousTo).getTime() - new Date(p7.previousFrom).getTime()
)
check("rolling window is flagged incomplete", p7.incomplete === true)

const yesterday = resolvePeriod("yesterday", now)
check("yesterday starts at midnight UTC", yesterday.from === "2026-06-14T00:00:00.000Z")
check("yesterday ends at today's midnight", yesterday.to === "2026-06-15T00:00:00.000Z")
check("a finished day is NOT incomplete", yesterday.incomplete === false)

const thisMonth = resolvePeriod("this_month", now)
check("this month starts on the 1st", thisMonth.from === "2026-06-01T00:00:00.000Z")
check("this month compares against May", thisMonth.previousFrom === "2026-05-01T00:00:00.000Z")
check("a month in progress is flagged incomplete", thisMonth.incomplete === true)

const lastMonth = resolvePeriod("last_month", now)
check("last month is May", lastMonth.from === "2026-05-01T00:00:00.000Z")
check("last month ends at June 1st", lastMonth.to === "2026-06-01T00:00:00.000Z")
check("a finished month is NOT incomplete", lastMonth.incomplete === false)

const custom = resolveCustomPeriod(new Date("2026-03-01"), new Date("2026-03-07"), now)
check("custom range includes the whole end day", custom.to === "2026-03-08T00:00:00.000Z")
check(
  "custom comparison window is the same length",
  new Date(custom.to).getTime() - new Date(custom.from).getTime() ===
    new Date(custom.previousTo).getTime() - new Date(custom.previousFrom).getTime()
)

// A leap-year boundary is where naive month arithmetic usually breaks.
const leap = resolvePeriod("last_month", new Date("2028-03-10T00:00:00.000Z"))
check("February 2028 resolves correctly", leap.from === "2028-02-01T00:00:00.000Z")
check("and ends on 1 March", leap.to === "2028-03-01T00:00:00.000Z")

/* -------------------------------------------------------------------------- */
section("2. HEALTH — unmeasurable dimensions score NULL, never a default")

function healthInputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    revenue: "0",
    revenue_previous: "0",
    revenue_growth_pct: null,
    gross_margin: null,
    net_margin: null,
    cost_coverage: null,
    refund_rate: null,
    expense_ratio: null,
    orders_count: 0,
    customers_count: 0,
    repeat_customer_rate: null,
    cancelled_rate: null,
    orders_without_channel: 0,
    orders_zero_fees: 0,
    variants_tracked: 0,
    variants_out_of_stock: 0,
    variants_below_reorder: 0,
    paid_order_value: "0",
    unpaid_order_value: "0",
    payment_capture_rate: null,
    ...overrides,
  }
}

const empty = calculateHealth(healthInputs())
check("an empty business scores null, not zero", empty.score === null)
check("status is unknown", empty.status === "unknown")
check("no dimensions were scored", empty.dimensionsScored === 0)
check("all six dimensions are still reported", empty.dimensions.length === 6)
check(
  "every dimension explains why it could not be scored",
  empty.dimensions.every((d) => d.reason.length > 20)
)

const healthy = calculateHealth(
  healthInputs({
    revenue: "100000",
    revenue_previous: "80000",
    revenue_growth_pct: "25",
    gross_margin: "42",
    net_margin: "18",
    cost_coverage: "100",
    orders_count: 200,
    customers_count: 120,
    repeat_customer_rate: "30",
    cancelled_rate: "1",
    variants_tracked: 40,
    variants_out_of_stock: 0,
    variants_below_reorder: 2,
    paid_order_value: "99000",
    unpaid_order_value: "1000",
    payment_capture_rate: "99",
    refund_rate: "2",
  })
)
check("a healthy business scores all six dimensions", healthy.dimensionsScored === 6)
check("revenue growth of 25% scores 100", healthy.dimensions[0].score === 100)
check("gross margin of 42% scores 100", healthy.dimensions[1].score === 100)
check("no stock-outs scores 100", healthy.dimensions[2].score === 100)
check("30% repeat rate scores 85", healthy.dimensions[3].score === 85)
check("99% capture scores 100", healthy.dimensions[4].score === 100)
check("clean operations scores 100", healthy.dimensions[5].score === 100)
check(
  "overall is the mean of the six: (100+100+100+85+100+100)/6 = 97.5 -> 98",
  healthy.score === 98,
  String(healthy.score)
)

const lowCoverage = calculateHealth(
  healthInputs({
    revenue: "50000",
    revenue_previous: "50000",
    revenue_growth_pct: "0",
    gross_margin: "60",
    cost_coverage: "40",
    orders_count: 50,
  })
)
const profitability = lowCoverage.dimensions.find((d) => d.key === "profitability")!
check(
  "a 60% margin built on 40% cost coverage is NOT scored",
  profitability.score === null,
  String(profitability.score)
)
check("and says why", profitability.reason.includes("40%"))
check("and refuses to estimate", (profitability.caveat ?? "").includes("will not estimate"))

const partialCoverage = calculateHealth(
  healthInputs({
    revenue: "50000",
    revenue_previous: "50000",
    revenue_growth_pct: "0",
    gross_margin: "35",
    cost_coverage: "80",
    orders_count: 50,
  })
)
const partial = partialCoverage.dimensions.find((d) => d.key === "profitability")!
check("80% coverage still scores, at 35% margin -> 85", partial.score === 85)
check("but is marked low confidence", partial.confidence === "low")
check("with a caveat saying the real margin is lower", (partial.caveat ?? "").includes("LOWER"))

const fewCustomers = calculateHealth(
  healthInputs({ revenue: "1000", orders_count: 5, customers_count: 4, repeat_customer_rate: "50" })
)
const customers = fewCustomers.dimensions.find((d) => d.key === "customers")!
check("a repeat rate over 4 customers is not scored", customers.score === null)
check("and says the sample is too small", customers.reason.includes("too few"))

const negativeMargin = calculateHealth(
  healthInputs({
    revenue: "10000",
    revenue_previous: "10000",
    revenue_growth_pct: "0",
    gross_margin: "-5",
    cost_coverage: "100",
    orders_count: 20,
  })
)
const negative = negativeMargin.dimensions.find((d) => d.key === "profitability")!
check("a negative margin scores 0", negative.score === 0)
check("and says the sales cost more than they earn", negative.reason.includes("negative"))

/* -------------------------------------------------------------------------- */
section("3. INSIGHTS — fire on evidence, stay silent without it")

function financials(overrides: Partial<Financials> = {}): Financials {
  return {
    revenue: "0",
    cogs: "0",
    fees: "0",
    gross_profit: "0",
    gross_margin: null,
    expenses: "0",
    net_profit: "0",
    net_margin: null,
    orders_count: 0,
    units_sold: "0",
    avg_order_value: null,
    customers_count: 0,
    refunds: "0",
    returns_count: 0,
    cancelled_orders: 0,
    items_total: 0,
    items_with_cost: 0,
    cost_coverage: null,
    orders_zero_fees: 0,
    orders_without_channel: 0,
    line_revenue: "0",
    orders_fees_unknown: 0,
    fee_coverage: null,
    cost_gap: null,
    fee_gap: null,
    refund_rate: null,
    line_revenue_derived: "0",
    items_value_derived: 0,
    items_value_unknown: 0,
    channel_scoped: false,
    ...overrides,
  }
}

function comparison(
  metric: string,
  current: string,
  previous: string,
  pct: string | null,
  direction: MetricComparison["direction"]
): MetricComparison {
  return {
    metric,
    current_value: current,
    previous_value: previous,
    absolute_change: null,
    percent_change: pct,
    direction,
  }
}

function context(overrides: {
  current?: Financials
  comparisons?: MetricComparison[]
  channels?: ChannelPerformance[]
  previousChannels?: ChannelPerformance[]
  products?: ProductPerformance[]
} = {}) {
  return {
    current: overrides.current ?? financials(),
    comparisons: new Map((overrides.comparisons ?? []).map((c) => [c.metric, c])),
    channels: overrides.channels ?? [],
    previousChannels: overrides.previousChannels ?? [],
    products: overrides.products ?? [],
    currency: "BDT",
    periodLabel: "Last 30 days",
  }
}

const nothing = generateInsights(context())
check("an empty business produces NO insights rather than filler", nothing.length === 0)

const trap = generateInsights(
  context({
    current: financials({ revenue: "10000", gross_profit: "3000", cost_coverage: "100", items_total: 5, items_with_cost: 5 }),
    comparisons: [
      comparison("revenue", "10000", "8000", "25", "up"),
      comparison("gross_profit", "3000", "3500", "-14.29", "down"),
    ],
  })
)
const revenueTrap = trap.find((i) => i.type === "revenue_up_profit_down")
check("revenue up + profit down fires", revenueTrap !== undefined)
check("and is treated as critical", revenueTrap?.severity === "critical")
check("and states the impact", (revenueTrap?.businessImpact ?? "").includes("expensive growth"))

const coverageGap = generateInsights(
  context({
    current: financials({
      revenue: "10000",
      gross_profit: "6000",
      cost_coverage: "40",
      items_total: 10,
      items_with_cost: 4,
    }),
  })
)
const coverageInsight = coverageGap.find((i) => i.type === "cost_coverage_incomplete")
check("incomplete cost data fires", coverageInsight !== undefined)
check("critical below 50% coverage", coverageInsight?.severity === "critical")
check("names the affected line count", (coverageInsight?.summary ?? "").includes("6 of 10"))
check(
  "and refuses to fill costs from the catalogue",
  (coverageInsight?.recommendedNextStep ?? "").includes("will not fill these in")
)

const channels: ChannelPerformance[] = [
  {
    channel_id: "a", channel_name: "Amazon", channel_type: "AMAZON",
    revenue: "3700", cogs: "1500", fees: "370", gross_profit: "1830", gross_margin: "49.46",
    orders_count: 2, units_sold: "3", avg_order_value: "1850",
    items_total: 2, items_with_cost: 2, cost_coverage: "100",
    orders_fees_unknown: 0, fee_coverage: "100",
  },
  {
    channel_id: "b", channel_name: "Website", channel_type: "WEBSITE",
    revenue: "2800", cogs: "900", fees: "0", gross_profit: "1900", gross_margin: "67.86",
    orders_count: 2, units_sold: "5", avg_order_value: "1400",
    items_total: 3, items_with_cost: 3, cost_coverage: "100",
    orders_fees_unknown: 0, fee_coverage: "100",
  },
]

const channelInsights = generateInsights(
  context({
    current: financials({ revenue: "6500", gross_profit: "3730", gross_margin: "57.38", cost_coverage: "100", items_total: 5, items_with_cost: 5 }),
    channels,
  })
)
const opportunity = channelInsights.find((i) => i.type === "channel_margin_opportunity")
check("the smaller-but-better-margin channel is spotted", opportunity !== undefined)
check("naming the right channel", (opportunity?.title ?? "").startsWith("Website earns"))

// Regression: a channel whose margin is only high because its costs are
// missing must NOT be recommended. Found on the live dashboard, where Website
// showed a 100% margin purely because one order had no recorded cost.
const inflatedMargin = generateInsights(
  context({
    current: financials({ revenue: "6500", gross_margin: "57.38", cost_coverage: "60", items_total: 5, items_with_cost: 3 }),
    channels: [
      channels[0],
      { ...channels[1], gross_margin: "100.00", cogs: "0", items_with_cost: 0, cost_coverage: "0" },
    ],
  })
)
check(
  "a channel whose margin is inflated by MISSING COSTS is not recommended",
  inflatedMargin.find((i) => i.type === "channel_margin_opportunity") === undefined
)
check(
  "the missing cost data is reported instead",
  inflatedMargin.find((i) => i.type === "cost_coverage_incomplete") !== undefined
)

// Regression: "Unattributed" is a bucket for orders with no channel, not a
// channel anyone can move effort towards. Seen on the live dashboard.
const unattributedBucket = generateInsights(
  context({
    current: financials({ revenue: "6500", gross_margin: "57.38", cost_coverage: "100", items_total: 5, items_with_cost: 5 }),
    channels: [
      channels[0],
      {
        ...channels[1],
        channel_id: null,
        channel_name: "Unattributed",
        gross_margin: "85.00",
      },
    ],
  })
)
check(
  "the unattributed bucket is never recommended as a channel",
  unattributedBucket.find((i) => i.type === "channel_margin_opportunity") === undefined
)

const deteriorated = generateInsights(
  context({
    current: financials({ revenue: "6500", cost_coverage: "100", items_total: 5, items_with_cost: 5 }),
    channels: [channels[0]],
    previousChannels: [{ ...channels[0], gross_margin: "62.00" }],
  })
)
const drop = deteriorated.find((i) => i.type === "channel_margin_deteriorated")
check("a margin drop of 12.5 points fires", drop !== undefined)
check("and is critical past 10 points", drop?.severity === "critical")

const coverageChanged = generateInsights(
  context({
    current: financials({ revenue: "6500", cost_coverage: "100", items_total: 5, items_with_cost: 5 }),
    channels: [{ ...channels[0], gross_margin: "40.00", cost_coverage: "50", items_with_cost: 1 }],
    previousChannels: [{ ...channels[0], gross_margin: "62.00" }],
  })
)
check(
  "a margin move caused by CHANGED COVERAGE is not reported as deterioration",
  coverageChanged.find((i) => i.type === "channel_margin_deteriorated") === undefined
)

const smallDrop = generateInsights(
  context({
    current: financials({ revenue: "6500", cost_coverage: "100", items_total: 5, items_with_cost: 5 }),
    channels: [channels[0]],
    previousChannels: [{ ...channels[0], gross_margin: "51.00" }],
  })
)
check(
  "a 1.5-point wobble does NOT fire",
  smallDrop.find((i) => i.type === "channel_margin_deteriorated") === undefined
)

const lowMargin = generateInsights(
  context({
    current: financials({ revenue: "10000", gross_margin: "50", cost_coverage: "100", items_total: 5, items_with_cost: 5 }),
    products: [
      {
        product_key: "sku:LOSS-1", product_id: null, name_source: "ORDER_LINE",
        sku: "LOSS-1", product_name: "Loss Leader", revenue: "1000", units_sold: "5",
        revenue_derived: "0",
        cogs: "1200", fees_allocated: "0", gross_profit: "-200", gross_margin: "-20",
        orders_count: 3, items_total: 3, items_with_cost: 3, cost_coverage: "100",
        items_measured: 3, items_value_derived: 0, items_value_unknown: 0,
      },
    ],
  })
)
const loss = lowMargin.find((i) => i.type === "low_margin_products")
check("a product selling at a loss fires", loss !== undefined)
check("as critical", loss?.severity === "critical")

const unknownCost = generateInsights(
  context({
    current: financials({ revenue: "10000", gross_margin: "50", cost_coverage: "100", items_total: 5, items_with_cost: 5 }),
    products: [
      {
        product_key: "sku:PARTIAL-1", product_id: null, name_source: "ORDER_LINE",
        sku: "PARTIAL-1", product_name: "Partly Costed", revenue: "1000", units_sold: "5",
        revenue_derived: "0",
        cogs: "100", fees_allocated: "0", gross_profit: "900", gross_margin: "90",
        orders_count: 3, items_total: 3, items_with_cost: 1, cost_coverage: "33.33",
        items_measured: 3, items_value_derived: 0, items_value_unknown: 0,
      },
    ],
  })
)
check(
  "a product with incomplete costs is NOT accused of a margin problem",
  unknownCost.find((i) => i.type === "low_margin_products") === undefined
)
check(
  "it is reported as a data gap instead",
  unknownCost.find((i) => i.type === "products_missing_cost") !== undefined
)

const growth = generateInsights(
  context({
    current: financials({ revenue: "10000", gross_profit: "4000", cost_coverage: "100", items_total: 5, items_with_cost: 5 }),
    comparisons: [
      comparison("revenue", "10000", "8000", "25", "up"),
      comparison("gross_profit", "4000", "3000", "33.33", "up"),
    ],
  })
)
check("healthy growth is acknowledged", growth.find((i) => i.type === "healthy_growth") !== undefined)

const growthUnverified = generateInsights(
  context({
    current: financials({ revenue: "10000", gross_profit: "4000", cost_coverage: "60", items_total: 5, items_with_cost: 3 }),
    comparisons: [
      comparison("revenue", "10000", "8000", "25", "up"),
      comparison("gross_profit", "4000", "3000", "33.33", "up"),
    ],
  })
)
check(
  "but NOT claimed when the profit figure cannot be trusted",
  growthUnverified.find((i) => i.type === "healthy_growth") === undefined
)

check(
  "insights are ordered most serious first",
  (() => {
    const rank = { critical: 0, warning: 1, positive: 2, info: 3 } as const
    return coverageGap.every(
      (insight, i, all) => i === 0 || rank[all[i - 1].severity] <= rank[insight.severity]
    )
  })()
)

/* -------------------------------------------------------------------------- */
section("4. EXACT DECIMAL COMPARISON -- no conversion, no arithmetic")

// The one thing TypeScript legitimately needs to do with money is put two
// figures in order. Doing that by subtracting Number() conversions is
// arithmetic, and it is wrong for values differing beyond a double's reach.

check("larger revenue wins", compareMoney("2000.00", "1000.00") > 0)
check("smaller loses", compareMoney("999.99", "1000.00") < 0)
check("equal is zero", compareMoney("1000.00", "1000.00") === 0)

check(
  "trailing zeros do not change a value -- 1000.1000 equals 1000.10",
  compareMoney("1000.1000", "1000.10") === 0
)
check("leading zeros are ignored", compareMoney("0007.5", "7.5") === 0)
check("a missing decimal part compares correctly", compareMoney("7", "7.0000") === 0)

check("negatives sort below positives", compareMoney("-1.00", "0.50") < 0)
check("two negatives order by magnitude", compareMoney("-5.00", "-2.00") < 0)
check("minus zero is still zero", compareMoney("-0.0000", "0") === 0)

// THE CASE A DOUBLE CANNOT HANDLE. 2^53 is representable; 2^53+1 is not, and
// rounds down onto it. Both become 9007199254740992, so subtracting Number()
// conversions reports two different figures as equal.
//
// The first version of this test used 2^53+1 and 2^53+2 and failed, because
// 2^53+2 IS representable. Worth keeping the corrected pair explicit: the
// boundary is not "large numbers", it is odd integers above 2^53.
const big = "9007199254740992.0000"
const bigger = "9007199254740993.0000"

check(
  "a difference beyond IEEE-754 precision is still detected",
  compareMoney(bigger, big) > 0,
  `Number() subtraction gives ${Number(bigger) - Number(big)}`
)
check(
  "and Number() genuinely cannot tell those two apart",
  Number(bigger) - Number(big) === 0
)
check(
  "small differences at the far end of the scale too",
  compareMoney("0.0001", "0.0002") < 0
)

// Unknown is not zero. A channel whose revenue was never recorded must not be
// presented as the smallest one.
check("unknown sorts last when ordering descending", byMoneyDescending(null, "0") > 0)
check("two unknowns are equal", compareMoney(null, undefined) === 0)
check("an empty string counts as unknown", compareMoney("", "5") < 0)

check("a positive figure is recognised", isPositiveMoney("0.0001"))
check("zero is not positive", !isPositiveMoney("0.0000"))
check("unknown is not positive", !isPositiveMoney(null))
check("an explicit zero is distinguishable from unknown", isZeroMoney("0.0000"))
check("and unknown is not zero", !isZeroMoney(null))

// A number reaching this code means the boundary is broken somewhere, and the
// live suite fails on exactly that. Here it must merely not crash.
check("a stray number is ordered rather than throwing", compareMoney(5, "3") > 0)
check("and a stray zero is still zero", isZeroMoney(0))

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
