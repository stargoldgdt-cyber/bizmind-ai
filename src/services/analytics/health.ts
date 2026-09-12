import type { HealthInputs, Ratio } from "./types"

/**
 * Business Health Score.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------
 * Every threshold below is a plain, stated band. There is no weighting model
 * derived from data we do not have, and no formula whose behaviour nobody
 * could predict. A score an owner cannot interrogate is a score they should
 * not trust, and inventing sophisticated mathematics to look rigorous would be
 * exactly the kind of false confidence this product exists to avoid.
 *
 * The bands are FIRST DRAFTS. They are reasonable for small multi-channel
 * commerce and they are not evidence-based, because BizMind has no customer
 * data yet to calibrate against. They are written here, in one place, in the
 * open, so they can be argued with and replaced.
 *
 * TWO RULES THAT MATTER MORE THAN THE NUMBERS
 * -------------------------------------------
 * 1. A dimension with no data scores NULL, never 50 and never 0. "We do not
 *    know" is a different answer from "average", and collapsing the two would
 *    manufacture a fact.
 *
 * 2. A dimension computed from unreliable inputs is marked low-confidence and
 *    says why. Profitability with 60% cost coverage is not a healthy 80 — it
 *    is a number that cannot yet be relied on.
 *
 * The overall score is the mean of the dimensions that COULD be measured, and
 * it reports how many those were. It never silently fills gaps.
 */

export type HealthStatus = "strong" | "healthy" | "watch" | "at_risk" | "unknown"

export type SupportingMetric = {
  label: string
  value: string
  format: "money" | "percent" | "count" | "text"
}

export type HealthDimension = {
  key: string
  label: string
  /** 0-100, or null when there is not enough data to judge. */
  score: number | null
  status: HealthStatus
  /** Plain-language explanation of why the score is what it is. */
  reason: string
  confidence: "high" | "low"
  /** Present when something makes the score less trustworthy. */
  caveat?: string
  supporting: SupportingMetric[]
}

/**
 * How much of the business the score actually saw.
 *
 *   high     every dimension measured, on inputs it can rely on
 *   limited  something was unmeasurable, or measured on incomplete inputs
 *   low      half the business could not be judged at all
 *
 * The headline number carries this with it. A 72 from four of six dimensions,
 * two of them built on incomplete costs, is not the same statement as a 72
 * from six, and showing them identically is how an incomplete business comes
 * to look healthy.
 */
export type HealthConfidence = "high" | "limited" | "low"

export type BusinessHealth = {
  score: number | null
  status: HealthStatus
  /** How many of the six dimensions could be measured at all. */
  dimensionsScored: number
  dimensionsTotal: number
  /** Measured, but on inputs that make the result unreliable. */
  dimensionsLowConfidence: number
  confidence: HealthConfidence
  /** The confidence, in the owner's language. Always present. */
  confidenceNote: string
  summary: string
  dimensions: HealthDimension[]
}

/** Parses a ratio the database computed. Never used on money. */
function num(value: Ratio | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Maps a value onto a score using stated bands, highest threshold first. */
function band(value: number, bands: [number, number][]): number {
  for (const [threshold, score] of bands) {
    if (value >= threshold) return score
  }
  return bands[bands.length - 1]?.[1] ?? 0
}

function statusFor(score: number | null): HealthStatus {
  if (score === null) return "unknown"
  if (score >= 80) return "strong"
  if (score >= 65) return "healthy"
  if (score >= 45) return "watch"
  return "at_risk"
}

const unknown = (
  key: string,
  label: string,
  reason: string,
  supporting: SupportingMetric[] = []
): HealthDimension => ({
  key,
  label,
  score: null,
  status: "unknown",
  reason,
  confidence: "low",
  supporting,
})

/* -------------------------------------------------------------------------- */

/**
 * REVENUE HEALTH — is money coming in, and is the trend improving?
 *
 * Bands on period-over-period growth:
 *   >= +20%  100   ·  >= +5%  85  ·  >= -5%  70  (roughly flat)
 *   >= -20%   45   ·  <  -20% 20
 */
function revenueHealth(input: HealthInputs): HealthDimension {
  const revenue = Number(input.revenue)
  const growth = num(input.revenue_growth_pct)

  if (revenue === 0) {
    return unknown(
      "revenue",
      "Revenue health",
      "No revenue was recorded in this period, so there is nothing to assess.",
      [{ label: "Revenue", value: input.revenue, format: "money" }]
    )
  }

  if (growth === null) {
    // Revenue exists but the previous period had none — a percentage change
    // would be meaningless, so the trend is simply unknown.
    return {
      key: "revenue",
      label: "Revenue health",
      score: null,
      status: "unknown",
      reason:
        "There was no revenue in the previous period, so growth cannot be measured yet. Come back after a full comparable period.",
      confidence: "low",
      supporting: [{ label: "Revenue", value: input.revenue, format: "money" }],
    }
  }

  const score = band(growth, [
    [20, 100],
    [5, 85],
    [-5, 70],
    [-20, 45],
    [-Infinity, 20],
  ])

  return {
    key: "revenue",
    label: "Revenue health",
    score,
    status: statusFor(score),
    reason:
      growth >= 5
        ? `Revenue grew ${growth}% compared with the previous period.`
        : growth >= -5
          ? `Revenue was broadly flat, ${growth}% against the previous period.`
          : `Revenue fell ${Math.abs(growth)}% compared with the previous period.`,
    confidence: "high",
    supporting: [
      { label: "Revenue", value: input.revenue, format: "money" },
      { label: "Previous period", value: input.revenue_previous, format: "money" },
      { label: "Change", value: String(growth), format: "percent" },
    ],
  }
}

/**
 * PROFITABILITY — does the revenue actually leave anything behind?
 *
 * Bands on gross margin:
 *   >= 40%  100  ·  >= 30%  85  ·  >= 20%  70  ·  >= 10%  50
 *   >=  0%   30  ·  <   0%   0
 *
 * Cost coverage below 100% means margin is overstated by an unknown amount, so
 * the dimension is marked low-confidence. Below 50% it is not scored at all —
 * a margin built on less than half the costs is not a measurement.
 */
function profitability(input: HealthInputs): HealthDimension {
  const margin = num(input.gross_margin)
  const coverage = num(input.cost_coverage)
  const netMargin = num(input.net_margin)

  const supporting: SupportingMetric[] = [
    { label: "Gross margin", value: input.gross_margin ?? "—", format: "percent" },
    { label: "Net margin", value: input.net_margin ?? "—", format: "percent" },
    { label: "Cost coverage", value: input.cost_coverage ?? "—", format: "percent" },
  ]

  if (margin === null) {
    return unknown(
      "profitability",
      "Profitability",
      "There was no revenue in this period, so margin cannot be calculated.",
      supporting
    )
  }

  if (coverage !== null && coverage < 50) {
    return {
      key: "profitability",
      label: "Profitability",
      score: null,
      status: "unknown",
      reason: `Only ${coverage}% of order lines have a recorded cost, so margin cannot be judged.`,
      confidence: "low",
      caveat:
        "Import cost prices on your sales export to make this measurable. BizMind will not estimate them.",
      supporting,
    }
  }

  const score = band(margin, [
    [40, 100],
    [30, 85],
    [20, 70],
    [10, 50],
    [0, 30],
    [-Infinity, 0],
  ])

  const incomplete = coverage !== null && coverage < 100

  return {
    key: "profitability",
    label: "Profitability",
    score,
    status: statusFor(score),
    reason:
      margin < 0
        ? `Gross margin is negative at ${margin}% — these sales cost more than they earn.`
        : `Gross margin is ${margin}%${netMargin !== null ? `, net ${netMargin}% after expenses` : ""}.`,
    confidence: incomplete ? "low" : "high",
    caveat: incomplete
      ? `Only ${coverage}% of order lines have a recorded cost, so the real margin is LOWER than shown.`
      : undefined,
    supporting,
  }
}

/**
 * INVENTORY HEALTH — can you keep selling?
 *
 * Bands on the share of tracked items that are out of stock:
 *   0%  100  ·  <= 5%  85  ·  <= 15%  65  ·  <= 30%  40  ·  > 30%  20
 * Items at or below their reorder point reduce the score by 10 when more than
 * a quarter of the catalogue is affected.
 */
function inventoryHealth(input: HealthInputs): HealthDimension {
  const tracked = input.variants_tracked

  if (tracked === 0) {
    return unknown(
      "inventory",
      "Inventory health",
      "No stock levels are being tracked yet. Import products with stock on hand to enable this.",
      []
    )
  }

  const outRate = (input.variants_out_of_stock / tracked) * 100
  const lowRate = (input.variants_below_reorder / tracked) * 100

  let score = band(-outRate, [
    [0, 100],
    [-5, 85],
    [-15, 65],
    [-30, 40],
    [-Infinity, 20],
  ])

  if (lowRate > 25) score = Math.max(score - 10, 0)

  return {
    key: "inventory",
    label: "Inventory health",
    score,
    status: statusFor(score),
    reason:
      input.variants_out_of_stock === 0
        ? `All ${tracked} tracked products are in stock.`
        : `${input.variants_out_of_stock} of ${tracked} tracked products are out of stock.`,
    confidence: "high",
    supporting: [
      { label: "Products tracked", value: String(tracked), format: "count" },
      { label: "Out of stock", value: String(input.variants_out_of_stock), format: "count" },
      { label: "At or below reorder point", value: String(input.variants_below_reorder), format: "count" },
    ],
  }
}

/**
 * CUSTOMER HEALTH — do buyers come back?
 *
 * Bands on repeat-customer rate within the period:
 *   >= 40%  100  ·  >= 25%  85  ·  >= 15%  70  ·  >= 5%  50  ·  < 5%  35
 *
 * Not scored below 10 customers: a repeat rate over a handful of buyers is
 * noise, and dressing noise as a score would be misleading.
 */
function customerHealth(input: HealthInputs): HealthDimension {
  const repeat = num(input.repeat_customer_rate)

  const supporting: SupportingMetric[] = [
    { label: "Customers who ordered", value: String(input.customers_count), format: "count" },
    { label: "Repeat rate", value: input.repeat_customer_rate ?? "—", format: "percent" },
  ]

  if (input.customers_count === 0) {
    return unknown(
      "customers",
      "Customer health",
      "No orders in this period had a customer attached, so repeat behaviour cannot be measured.",
      supporting
    )
  }

  if (input.customers_count < 10 || repeat === null) {
    return unknown(
      "customers",
      "Customer health",
      `Only ${input.customers_count} customers ordered in this period — too few to read a repeat rate from.`,
      supporting
    )
  }

  const score = band(repeat, [
    [40, 100],
    [25, 85],
    [15, 70],
    [5, 50],
    [-Infinity, 35],
  ])

  return {
    key: "customers",
    label: "Customer health",
    score,
    status: statusFor(score),
    reason: `${repeat}% of customers who ordered in this period ordered more than once.`,
    confidence: "high",
    supporting,
  }
}

/**
 * PAYMENT AND CASH — is the money actually arriving?
 *
 * Bands on payment capture rate (paid value / paid + pending + failed):
 *   >= 98%  100  ·  >= 90%  80  ·  >= 75%  55  ·  < 75%  30
 */
function paymentHealth(input: HealthInputs): HealthDimension {
  const capture = num(input.payment_capture_rate)

  const supporting: SupportingMetric[] = [
    { label: "Collected", value: input.paid_order_value, format: "money" },
    { label: "Outstanding", value: input.unpaid_order_value, format: "money" },
    { label: "Capture rate", value: input.payment_capture_rate ?? "—", format: "percent" },
  ]

  if (capture === null) {
    return unknown(
      "payments",
      "Payment health",
      "No payments were recorded in this period, so collection cannot be assessed.",
      supporting
    )
  }

  const score = band(capture, [
    [98, 100],
    [90, 80],
    [75, 55],
    [-Infinity, 30],
  ])

  return {
    key: "payments",
    label: "Payment health",
    score,
    status: statusFor(score),
    reason:
      capture >= 98
        ? "Essentially all recorded payments have been collected."
        : `${capture}% of recorded payment value has been collected; the rest is outstanding or failed.`,
    confidence: "high",
    supporting,
  }
}

/**
 * OPERATIONS — is the business running cleanly, and is its data trustworthy?
 *
 * Starts at 100 and deducts for stated problems:
 *   cancelled rate > 10%          -25
 *   cancelled rate > 5%           -10
 *   any orders with no channel    -15  (channel profit is then incomplete)
 *   cost coverage < 100%          -15  (profit is overstated)
 *   refund rate > 10%             -15
 */
function operationsHealth(input: HealthInputs): HealthDimension {
  if (input.orders_count === 0) {
    return unknown(
      "operations",
      "Operations",
      "No orders in this period, so there is nothing to assess.",
      []
    )
  }

  const cancelled = num(input.cancelled_rate) ?? 0
  const coverage = num(input.cost_coverage)
  const refundRate = num(input.refund_rate) ?? 0

  let score = 100
  const problems: string[] = []

  if (cancelled > 10) {
    score -= 25
    problems.push(`${cancelled}% of orders were cancelled`)
  } else if (cancelled > 5) {
    score -= 10
    problems.push(`${cancelled}% of orders were cancelled`)
  }

  if (input.orders_without_channel > 0) {
    score -= 15
    problems.push(`${input.orders_without_channel} orders are not attributed to a channel`)
  }

  if (coverage !== null && coverage < 100) {
    score -= 15
    problems.push(`cost data covers only ${coverage}% of order lines`)
  }

  if (refundRate > 10) {
    score -= 15
    problems.push(`refunds are ${refundRate}% of revenue`)
  }

  score = Math.max(score, 0)

  return {
    key: "operations",
    label: "Operations",
    score,
    status: statusFor(score),
    reason:
      problems.length === 0
        ? "No operational or data-quality problems detected in this period."
        : `Issues found: ${problems.join("; ")}.`,
    confidence: "high",
    supporting: [
      { label: "Cancelled rate", value: input.cancelled_rate ?? "—", format: "percent" },
      { label: "Orders without a channel", value: String(input.orders_without_channel), format: "count" },
      { label: "Cost coverage", value: input.cost_coverage ?? "—", format: "percent" },
      { label: "Refund rate", value: input.refund_rate ?? "—", format: "percent" },
    ],
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Combines the dimensions into one score.
 *
 * The mean of what could be measured, rounded. Unmeasurable dimensions are
 * EXCLUDED rather than given a default — averaging in a fabricated 50 would
 * quietly move the headline number, which is the one people remember.
 */
export function calculateHealth(input: HealthInputs): BusinessHealth {
  const dimensions = [
    revenueHealth(input),
    profitability(input),
    inventoryHealth(input),
    customerHealth(input),
    paymentHealth(input),
    operationsHealth(input),
  ]

  const scored = dimensions.filter((d): d is HealthDimension & { score: number } => d.score !== null)
  const lowConfidence = scored.filter((d) => d.confidence === "low").length
  const unmeasured = dimensions.length - scored.length

  // Half the business unjudged, or half of what was judged unreliable, is a
  // score to treat as an indication rather than a measurement.
  const confidence: HealthConfidence =
    scored.length * 2 <= dimensions.length || lowConfidence * 2 >= scored.length
      ? "low"
      : unmeasured > 0 || lowConfidence > 0
        ? "limited"
        : "high"

  const notes: string[] = []
  if (unmeasured > 0) {
    notes.push(
      `${unmeasured} of ${dimensions.length} areas could not be measured and are left out of the score`
    )
  }
  if (lowConfidence > 0) {
    notes.push(
      `${lowConfidence} ${lowConfidence === 1 ? "area is" : "areas are"} measured on incomplete data`
    )
  }
  const confidenceNote =
    notes.length === 0
      ? "Every area was measured on complete data."
      : `${notes.join(", and ")}.`

  if (scored.length === 0) {
    return {
      score: null,
      status: "unknown",
      dimensionsScored: 0,
      dimensionsTotal: dimensions.length,
      dimensionsLowConfidence: 0,
      confidence: "low",
      confidenceNote:
        "Nothing could be measured yet, so there is no score to trust or doubt.",
      summary:
        "There is not enough data yet to score this business. Import sales, costs and expenses to begin.",
      dimensions,
    }
  }

  const score = Math.round(scored.reduce((sum, d) => sum + d.score, 0) / scored.length)
  const weakest = scored.reduce((worst, d) => (d.score < worst.score ? d : worst), scored[0])

  return {
    score,
    status: statusFor(score),
    dimensionsScored: scored.length,
    dimensionsTotal: dimensions.length,
    dimensionsLowConfidence: lowConfidence,
    confidence,
    confidenceNote,
    summary:
      scored.length < dimensions.length
        ? `Scored on ${scored.length} of ${dimensions.length} areas — the rest do not have enough data yet. Weakest area: ${weakest.label}.`
        : `Weakest area: ${weakest.label}.`,
    dimensions,
  }
}
