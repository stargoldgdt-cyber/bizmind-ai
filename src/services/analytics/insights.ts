import type {
  ChannelPerformance,
  Financials,
  MetricComparison,
  ProductPerformance,
  Ratio,
} from "./types"

/**
 * The insight engine.
 *
 * Deterministic rules over already-verified figures. No language model is
 * involved and none will be: an insight that says "profit fell while revenue
 * rose" must be true because the arithmetic says so, not because a model found
 * the sentence plausible.
 *
 * Later, AI will EXPLAIN these insights in an owner's own context. It will not
 * generate them, and it will not recalculate the numbers inside them.
 *
 * `recommendedNextStep` is descriptive at this phase. Nothing here acts.
 */

export type InsightSeverity = "critical" | "warning" | "info" | "positive"

export type InsightMetric = {
  label: string
  value: string
  format: "money" | "percent" | "count" | "text"
}

export type Insight = {
  type: string
  severity: InsightSeverity
  title: string
  summary: string
  supportingMetrics: InsightMetric[]
  businessImpact: string
  recommendedNextStep: string
}

type Context = {
  current: Financials
  comparisons: Map<string, MetricComparison>
  channels: ChannelPerformance[]
  previousChannels: ChannelPerformance[]
  products: ProductPerformance[]
  currency: string
  periodLabel: string
}

/** Ratios only. Never called on a money value. */
function num(value: Ratio | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Ordering for display: the most serious first. */
const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  positive: 2,
  info: 3,
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The signature BizMind insight: more money coming in, less staying.
 * Only fires when both directions are known, so a missing margin cannot
 * produce a phantom warning.
 */
function revenueUpProfitDown(ctx: Context): Insight | null {
  const revenue = ctx.comparisons.get("revenue")
  const profit = ctx.comparisons.get("gross_profit")
  if (!revenue || !profit) return null
  if (revenue.direction !== "up" || profit.direction !== "down") return null

  const revenuePct = num(revenue.percent_change)
  const profitPct = num(profit.percent_change)

  return {
    type: "revenue_up_profit_down",
    severity: "critical",
    title: "Revenue grew but profit fell",
    summary:
      `Revenue rose${revenuePct !== null ? ` ${revenuePct}%` : ""} while gross profit ` +
      `fell${profitPct !== null ? ` ${Math.abs(profitPct)}%` : ""}. You sold more and kept less.`,
    supportingMetrics: [
      { label: "Revenue", value: revenue.current_value ?? "—", format: "money" },
      { label: "Revenue change", value: revenue.percent_change ?? "—", format: "percent" },
      { label: "Gross profit", value: profit.current_value ?? "—", format: "money" },
      { label: "Profit change", value: profit.percent_change ?? "—", format: "percent" },
    ],
    businessImpact:
      "Growth that reduces profit is expensive growth. Left alone it scales the problem rather than the business.",
    recommendedNextStep:
      "Compare channel margins below. The usual causes are rising channel fees, a shift in mix towards lower-margin products, or discounting.",
  }
}

/**
 * Cost coverage below 100% means every margin on screen is overstated by an
 * unknown amount. This is the most important caveat the product can raise, so
 * it fires whenever it applies.
 */
function incompleteCostData(ctx: Context): Insight | null {
  const coverage = num(ctx.current.cost_coverage)
  if (coverage === null || coverage >= 100) return null

  const missing = ctx.current.items_total - ctx.current.items_with_cost

  return {
    type: "cost_coverage_incomplete",
    severity: coverage < 50 ? "critical" : "warning",
    title: `Profit figures are overstated — ${coverage}% cost coverage`,
    summary:
      `${missing} of ${ctx.current.items_total} order lines have no recorded cost. ` +
      `Those lines contribute nothing to cost of goods, so gross profit and every ` +
      `margin shown are higher than reality by an unknown amount.`,
    supportingMetrics: [
      { label: "Cost coverage", value: ctx.current.cost_coverage ?? "—", format: "percent" },
      { label: "Lines without cost", value: String(missing), format: "count" },
      { label: "Reported gross profit", value: ctx.current.gross_profit, format: "money" },
    ],
    businessImpact:
      "Decisions about pricing, discounting and which products to push are being made on a profit figure that is too high.",
    recommendedNextStep:
      "Include a unit cost column in your sales export and import it again. BizMind will not fill these in from your product list, because that is today's price rather than the cost at the time of sale.",
  }
}

/**
 * A channel that brings in less but keeps more. This is the comparison the
 * product exists to make obvious.
 */
function betterMarginSmallerChannel(ctx: Context): Insight | null {
  // Only compare channels whose costs are FULLY known. A channel with missing
  // costs shows an inflated margin, and recommending someone move effort
  // towards it would be advice manufactured from a data gap -- the exact
  // failure this engine exists to avoid.
  const ranked = ctx.channels
    .filter(
      (c) =>
        // "Unattributed" is not a channel anyone can invest in -- it is the
        // bucket for orders with no channel recorded. Recommending effort be
        // moved there would be advice with no possible action behind it.
        c.channel_id !== null &&
        num(c.gross_margin) !== null &&
        Number(c.revenue) > 0 &&
        num(c.cost_coverage) === 100
    )
    .sort((a, b) => Number(b.revenue) - Number(a.revenue))

  if (ranked.length < 2) return null

  const biggest = ranked[0]
  const bestMargin = ranked.reduce((best, c) =>
    (num(c.gross_margin) ?? -Infinity) > (num(best.gross_margin) ?? -Infinity) ? c : best
  )

  if (bestMargin.channel_name === biggest.channel_name) return null

  const biggestMargin = num(biggest.gross_margin)
  const betterMargin = num(bestMargin.gross_margin)
  if (biggestMargin === null || betterMargin === null) return null
  if (betterMargin - biggestMargin < 5) return null

  return {
    type: "channel_margin_opportunity",
    severity: "info",
    title: `${bestMargin.channel_name} earns a better margin than ${biggest.channel_name}`,
    summary:
      `${biggest.channel_name} brings in the most revenue at ${biggestMargin}% margin, ` +
      `but ${bestMargin.channel_name} keeps ${betterMargin}% of every sale.`,
    supportingMetrics: [
      { label: `${biggest.channel_name} revenue`, value: biggest.revenue, format: "money" },
      { label: `${biggest.channel_name} margin`, value: biggest.gross_margin ?? "—", format: "percent" },
      { label: `${bestMargin.channel_name} revenue`, value: bestMargin.revenue, format: "money" },
      { label: `${bestMargin.channel_name} margin`, value: bestMargin.gross_margin ?? "—", format: "percent" },
    ],
    businessImpact:
      "Shifting effort towards the higher-margin channel can raise profit without raising sales.",
    recommendedNextStep:
      `Look at what limits volume on ${bestMargin.channel_name}. If the constraint is demand rather than capacity, it may be worth the marketing spend currently going elsewhere.`,
  }
}

/** A channel whose margin got materially worse than the previous period. */
function channelMarginDeteriorated(ctx: Context): Insight[] {
  const previous = new Map(ctx.previousChannels.map((c) => [c.channel_name, c]))
  const out: Insight[] = []

  for (const channel of ctx.channels) {
    // Same reasoning as above: the unattributed bucket is a data artefact,
    // not a channel whose performance can be managed.
    if (channel.channel_id === null) continue

    const before = previous.get(channel.channel_name)
    if (!before) continue

    const now = num(channel.gross_margin)
    const then = num(before.gross_margin)
    if (now === null || then === null) continue

    // If cost coverage differs between the periods, the margin moved because
    // the DATA changed, not because the business did. Saying otherwise would
    // send someone hunting for a cause that does not exist.
    if (num(channel.cost_coverage) !== 100 || num(before.cost_coverage) !== 100) continue

    const drop = then - now
    if (drop < 5) continue

    out.push({
      type: "channel_margin_deteriorated",
      severity: drop >= 10 ? "critical" : "warning",
      title: `${channel.channel_name} margin fell ${drop.toFixed(1)} points`,
      summary:
        `${channel.channel_name} earned ${then}% margin last period and ${now}% this period.`,
      supportingMetrics: [
        { label: "Margin now", value: channel.gross_margin ?? "—", format: "percent" },
        { label: "Margin before", value: before.gross_margin ?? "—", format: "percent" },
        { label: "Revenue", value: channel.revenue, format: "money" },
        { label: "Fees", value: channel.fees, format: "money" },
      ],
      businessImpact:
        "A falling channel margin compounds: every additional sale through it returns less than the last.",
      recommendedNextStep:
        "Check whether fees on this channel rose, costs increased, or the product mix shifted towards cheaper items.",
    })
  }

  return out
}

/** Expenses growing much faster than revenue. */
function expenseGrowthOutpacingRevenue(ctx: Context): Insight | null {
  const expenses = ctx.comparisons.get("expenses")
  const revenue = ctx.comparisons.get("revenue")
  if (!expenses || !revenue) return null

  const expensePct = num(expenses.percent_change)
  const revenuePct = num(revenue.percent_change)
  if (expensePct === null) return null
  if (expensePct < 30) return null
  if (revenuePct !== null && expensePct - revenuePct < 20) return null

  return {
    type: "expense_growth",
    severity: expensePct >= 50 ? "critical" : "warning",
    title: `Expenses rose ${expensePct}%`,
    summary:
      revenuePct === null
        ? `Operating expenses rose ${expensePct}% compared with the previous period.`
        : `Operating expenses rose ${expensePct}% while revenue moved ${revenuePct}%.`,
    supportingMetrics: [
      { label: "Expenses", value: expenses.current_value ?? "—", format: "money" },
      { label: "Previous", value: expenses.previous_value ?? "—", format: "money" },
      { label: "Change", value: expenses.percent_change ?? "—", format: "percent" },
    ],
    businessImpact:
      "Expenses growing faster than revenue erode net profit even while the top line looks healthy.",
    recommendedNextStep:
      "Review expenses by category for this period and identify which line grew.",
  }
}

/** Products selling at an unusually low margin against the business average. */
function lowMarginProducts(ctx: Context): Insight | null {
  const overall = num(ctx.current.gross_margin)
  if (overall === null) return null

  const candidates = ctx.products
    .filter((p) => {
      const margin = num(p.gross_margin)
      const coverage = num(p.cost_coverage)
      // Only judge products whose costs are fully known — otherwise the low
      // margin might be a data gap rather than a pricing problem.
      return margin !== null && coverage === 100 && Number(p.revenue) > 0 && margin < overall - 15
    })
    .sort((a, b) => (num(a.gross_margin) ?? 0) - (num(b.gross_margin) ?? 0))
    .slice(0, 3)

  if (candidates.length === 0) return null

  const worst = candidates[0]

  return {
    type: "low_margin_products",
    severity: (num(worst.gross_margin) ?? 0) < 0 ? "critical" : "warning",
    title:
      (num(worst.gross_margin) ?? 0) < 0
        ? `${worst.product_name} is selling at a loss`
        : `${candidates.length} product${candidates.length === 1 ? "" : "s"} well below your average margin`,
    summary:
      `Your overall margin is ${overall}%. ${worst.product_name} (${worst.sku}) is earning ` +
      `${worst.gross_margin}% across ${worst.orders_count} order${worst.orders_count === 1 ? "" : "s"}.`,
    supportingMetrics: candidates.map((p) => ({
      label: `${p.product_name} (${p.sku})`,
      value: p.gross_margin ?? "—",
      format: "percent" as const,
    })),
    businessImpact:
      "Low-margin products consume stock, cash and attention while contributing little profit.",
    recommendedNextStep:
      "Check the selling price and the recorded cost for these products. Decide whether to reprice, renegotiate supply, or stop stocking them.",
  }
}

/** Products with no cost recorded — the fixable half of a coverage gap. */
function productsMissingCost(ctx: Context): Insight | null {
  const missing = ctx.products.filter((p) => (num(p.cost_coverage) ?? 100) < 100)
  if (missing.length === 0) return null

  const revenueAffected = missing.length

  return {
    type: "products_missing_cost",
    severity: "warning",
    title:
      revenueAffected === 1
        ? "1 product has sales with no recorded cost"
        : `${revenueAffected} products have sales with no recorded cost`,
    summary:
      `These products show a profit that is higher than reality, because some or all ` +
      `of their sales have no cost recorded against them.`,
    supportingMetrics: missing.slice(0, 5).map((p) => ({
      label: `${p.product_name} (${p.sku})`,
      value: p.cost_coverage ?? "—",
      format: "percent" as const,
    })),
    businessImpact:
      "Per-product profit cannot be trusted for these items, so decisions about which to promote may be wrong.",
    recommendedNextStep:
      "Re-import the affected sales with a unit cost column included.",
  }
}

/** Orders that belong to no channel make channel profitability incomplete. */
function unattributedOrders(ctx: Context): Insight | null {
  if (ctx.current.orders_without_channel === 0) return null

  return {
    type: "unattributed_orders",
    severity: "info",
    title: `${ctx.current.orders_without_channel} orders are not attributed to a channel`,
    summary:
      "These orders are grouped as “Unattributed”, so channel comparisons do not tell the full story.",
    supportingMetrics: [
      { label: "Orders without a channel", value: String(ctx.current.orders_without_channel), format: "count" },
      { label: "Total orders", value: String(ctx.current.orders_count), format: "count" },
    ],
    businessImpact:
      "You cannot tell which channel earned this revenue, so effort may be directed at the wrong one.",
    recommendedNextStep:
      "When importing, set the channel the file came from so orders are attributed automatically.",
  }
}

/** Refunds eating a material share of revenue. */
function highRefundRate(ctx: Context): Insight | null {
  const revenue = Number(ctx.current.revenue)
  if (revenue <= 0) return null

  const refunds = Number(ctx.current.refunds)
  if (refunds <= 0) return null

  // Ratio of two figures the database produced; used only to pick a threshold.
  const rate = (refunds / revenue) * 100
  if (rate < 5) return null

  return {
    type: "high_refund_rate",
    severity: rate >= 10 ? "critical" : "warning",
    title: `Refunds are ${rate.toFixed(1)}% of revenue`,
    summary: `${ctx.current.returns_count} returns totalling ${ctx.current.refunds} were recorded this period.`,
    supportingMetrics: [
      { label: "Refunds", value: ctx.current.refunds, format: "money" },
      { label: "Revenue", value: ctx.current.revenue, format: "money" },
      { label: "Returns", value: String(ctx.current.returns_count), format: "count" },
    ],
    businessImpact:
      "Refunds remove revenue you have already paid costs and fees to earn, so they hurt profit more than the headline figure suggests.",
    recommendedNextStep:
      "Look at which products and channels the returns came from, and whether a listing or quality issue explains them.",
  }
}

/** Worth saying when things are genuinely going well and the data supports it. */
function healthyGrowth(ctx: Context): Insight | null {
  const revenue = ctx.comparisons.get("revenue")
  const profit = ctx.comparisons.get("gross_profit")
  const coverage = num(ctx.current.cost_coverage)

  if (!revenue || !profit) return null
  if (revenue.direction !== "up" || profit.direction !== "up") return null
  // Only claim healthy growth when the profit figure can be trusted.
  if (coverage === null || coverage < 100) return null

  return {
    type: "healthy_growth",
    severity: "positive",
    title: "Revenue and profit both grew",
    summary:
      `Revenue rose ${revenue.percent_change ?? "—"}% and gross profit rose ` +
      `${profit.percent_change ?? "—"}%, with complete cost data behind it.`,
    supportingMetrics: [
      { label: "Revenue", value: revenue.current_value ?? "—", format: "money" },
      { label: "Gross profit", value: profit.current_value ?? "—", format: "money" },
      { label: "Cost coverage", value: ctx.current.cost_coverage ?? "—", format: "percent" },
    ],
    businessImpact: "Growth that keeps its margin is the kind worth repeating.",
    recommendedNextStep:
      "Identify which channel and products drove it, so the effort can be concentrated there.",
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Runs every rule and returns what fired, most serious first.
 *
 * An empty result is a legitimate outcome and must not be padded. Inventing a
 * finding to fill the space is how a product teaches people to ignore it.
 */
export function generateInsights(ctx: Context): Insight[] {
  const insights: Insight[] = []

  const single = [
    revenueUpProfitDown,
    incompleteCostData,
    expenseGrowthOutpacingRevenue,
    lowMarginProducts,
    productsMissingCost,
    betterMarginSmallerChannel,
    unattributedOrders,
    highRefundRate,
    healthyGrowth,
  ]

  for (const rule of single) {
    const insight = rule(ctx)
    if (insight) insights.push(insight)
  }

  insights.push(...channelMarginDeteriorated(ctx))

  return insights.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

export type { Context as InsightContext }
