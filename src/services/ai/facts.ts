/**
 * The fact sheet.
 *
 * COMPUTE FIRST, THEN NARRATE.
 *
 * A language model never sees an order, a line item, or anything it could add
 * up. It sees this: a list of figures BizMind already calculated in SQL, each
 * with a label, a formatted value, and where relevant a definition and a
 * warning about how reliable it is.
 *
 * Two things follow from that, and both matter:
 *
 *   1. The model has nothing to calculate FROM, so arithmetic is not merely
 *      forbidden, it is impossible. There are no operands.
 *   2. Every number it is allowed to say is enumerable, because it is exactly
 *      the numbers in this sheet. That is what `guard.ts` checks.
 *
 * This module does no arithmetic either. It formats figures for display, using
 * the same helpers the dashboard uses, so the sentence an owner reads carries
 * the same value as the card above it.
 */

import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { isPositiveMoney } from "@/services/analytics/money"
import type { Insight } from "@/services/analytics/insights"
import type {
  ChannelPerformance,
  Financials,
  MetricComparison,
  ProductPerformance,
} from "@/services/analytics/types"
import { METRICS } from "@/services/analytics/types"
import type { BusinessHealth } from "@/services/analytics/health"

/** One verified figure the model is permitted to mention. */
export type Fact = {
  /** The canonical metric key, where the fact is one. */
  key: string
  label: string
  /** Exactly as the dashboard shows it. */
  display: string
  /** How it is calculated, in the owner's language. Included when it exists. */
  definition?: string
  /** What makes it unreliable right now. Included only when it applies. */
  caveat?: string
}

export type FactSheet = {
  businessName: string
  currency: string
  periodLabel: string
  comparisonLabel: string
  /** Which slice of the business these figures cover, in the owner's words. */
  scopeLabel: string
  /** True when a channel filter is on, so expenses and net profit are absent. */
  channelScoped: boolean
  /** True when the period is still running, so comparisons look weak. */
  periodIncomplete: boolean
  headline: Fact[]
  changes: Fact[]
  channels: Fact[]
  products: Fact[]
  quality: Fact[]
  health: Fact[]
  /** The deterministic findings. The model explains these; it never invents one. */
  insights: Insight[]
}

export type FactSheetInput = {
  businessName: string
  currency: string
  periodLabel: string
  comparisonLabel: string
  /**
   * Which slice the figures cover: "the whole business", "the Amazon channel
   * only", "orders with no channel recorded".
   *
   * WITHOUT THIS THE BRIEF CAN BE TRUE AND STILL WRONG. An owner looking at a
   * dashboard filtered to Amazon, reading a paragraph about the whole
   * business, has no way to tell which they are being told about.
   */
  scopeLabel: string
  /** A channel filter is on, so expenses and net profit are not available. */
  channelScoped: boolean
  periodIncomplete: boolean
  current: Financials
  comparisons: MetricComparison[]
  channels: ChannelPerformance[]
  products: ProductPerformance[]
  health: BusinessHealth
  insights: Insight[]
}

/** How many rows of a list the model is given. Enough to reason, not to drown. */
const LIST_LIMIT = 5

function fact(key: string, display: string, label?: string): Fact {
  const definition = METRICS[key]
  return {
    key,
    label: label ?? definition?.label ?? key,
    display,
    definition: definition?.definition,
  }
}

/**
 * Builds the sheet.
 *
 * Anything the database could not calculate is stated as "not calculated"
 * rather than omitted. A missing line would let the model assume zero; a line
 * that says the figure does not exist cannot be misread that way.
 */
export function buildFactSheet(input: FactSheetInput): FactSheet {
  const { current, currency } = input
  const money = (value: string | null) => formatMoney(value, currency)

  const headline: Fact[] = [
    fact("revenue", money(current.revenue)),
    fact("cogs", money(current.cogs)),
    fact("fees", money(current.fees)),
    fact("gross_profit", money(current.gross_profit)),
    fact("gross_margin", formatPercent(current.gross_margin)),
    fact("expenses", money(current.expenses)),
    fact("net_profit", money(current.net_profit)),
    fact("orders_count", formatNumber(current.orders_count)),
    fact("units_sold", formatNumber(current.units_sold, 2)),
    fact("avg_order_value", money(current.avg_order_value)),
    fact("customers_count", formatNumber(current.customers_count)),
    fact("refunds", money(current.refunds)),
  ]

  // A period-over-period change is calculated in SQL, like everything else.
  // The model is given the result, never the two values and a subtraction.
  const changes: Fact[] = input.comparisons
    .filter((comparison) => METRICS[comparison.metric] !== undefined)
    .map((comparison) => {
      const definition = METRICS[comparison.metric]
      const percent =
        comparison.percent_change === null
          ? "no comparison available (there was nothing to compare against)"
          : `${formatPercent(comparison.percent_change)} ${comparison.direction}`

      return {
        key: comparison.metric,
        label: `${definition.label} change vs ${input.comparisonLabel}`,
        display: percent,
      }
    })

  const channels: Fact[] = input.channels.slice(0, LIST_LIMIT).map((channel) => ({
    key: "channel",
    label: channel.channel_name,
    display:
      `revenue ${money(channel.revenue)}, ` +
      `gross profit ${money(channel.gross_profit)}, ` +
      `margin ${formatPercent(channel.gross_margin)}, ` +
      `orders ${formatNumber(channel.orders_count)}`,
    caveat:
      Number(channel.cost_coverage ?? 0) < 100 || Number(channel.fee_coverage ?? 0) < 100
        ? `Costs recorded on ${formatPercent(channel.cost_coverage)} of lines and fees on ` +
          `${formatPercent(channel.fee_coverage)} of orders, so this margin is overstated.`
        : undefined,
  }))

  const products: Fact[] = input.products.slice(0, LIST_LIMIT).map((product) => {
    // Every reason this product's figures are less than complete, stated.
    const caveats = [
      Number(product.cost_coverage ?? 0) < 100
        ? `Costs recorded on ${formatPercent(product.cost_coverage)} of lines, so this ` +
          `margin is overstated.`
        : null,
      product.items_value_unknown > 0
        ? `${formatNumber(product.items_value_unknown)} of its order lines have no recorded ` +
          `value, so its revenue and profit leave them out.`
        : null,
      isPositiveMoney(product.revenue_derived)
        ? `${money(product.revenue_derived)} of its revenue was CALCULATED as quantity x unit ` +
          `price, because the source gave no line total.`
        : null,
    ].filter((line): line is string => line !== null)

    return {
      key: "product",
      label: product.product_name,
      display:
        `revenue ${money(product.revenue)}, ` +
        `gross profit ${money(product.gross_profit)}, ` +
        `margin ${formatPercent(product.gross_margin)}, ` +
        `units ${formatNumber(product.units_sold, 2)}`,
      caveat: caveats.length > 0 ? caveats.join(" ") : undefined,
    }
  })

  // The honesty section. Without it a model reading only the headline figures
  // would describe an overstated margin as though it were settled fact.
  const quality: Fact[] = [
    {
      key: "cost_gap",
      label: "Share of order lines with NO recorded cost",
      display:
        current.cost_gap === null
          ? "not calculated (there are no order lines in this period)"
          : formatPercent(current.cost_gap),
      definition:
        "The proportion of order lines where no cost was recorded at the time " +
        "of sale. Those lines contribute nothing to cost of goods, so profit " +
        "is overstated.",
    },
    {
      key: "fee_gap",
      label: "Share of orders with NO recorded fee",
      display:
        current.fee_gap === null
          ? "not calculated (there are no orders in this period)"
          : formatPercent(current.fee_gap),
      definition:
        "The proportion of orders where the source did not record a fee. That " +
        "is unknown, not zero.",
    },
    {
      key: "cost_coverage",
      label: "Cost coverage",
      display:
        current.cost_coverage === null
          ? "not calculated (there are no order lines in this period)"
          : formatPercent(current.cost_coverage),
      definition: METRICS.cost_coverage.definition,
      caveat:
        current.items_total > current.items_with_cost
          ? `${formatNumber(current.items_total - current.items_with_cost)} of ` +
            `${formatNumber(current.items_total)} order lines have no recorded cost, so ` +
            `cost of goods is understated and every profit figure above is overstated.`
          : undefined,
    },
    {
      key: "fee_coverage",
      label: "Fee coverage",
      display:
        current.fee_coverage === null
          ? "not calculated (there are no orders in this period)"
          : formatPercent(current.fee_coverage),
      definition: METRICS.fee_coverage.definition,
      caveat:
        current.orders_fees_unknown > 0
          ? `${formatNumber(current.orders_fees_unknown)} of ` +
            `${formatNumber(current.orders_count)} orders have no fee recorded. That is ` +
            `unknown, not zero, so profit is overstated by an unknown amount.`
          : undefined,
    },
    {
      key: "orders_without_channel",
      label: "Orders with no channel recorded",
      display: formatNumber(current.orders_without_channel),
    },
  ]

  const health: Fact[] = [
    {
      key: "health_score",
      label: "Business health score",
      display:
        input.health.score === null
          ? "not calculated (not enough data to score it)"
          : `${formatNumber(input.health.score)} out of 100, status: ${input.health.status}`,
    },
    {
      key: "health_coverage",
      label: "Health dimensions that could be measured",
      display: `${formatNumber(input.health.dimensionsScored)} of ${formatNumber(
        input.health.dimensionsTotal
      )}`,
    },
    {
      key: "health_confidence",
      label: "How far the health score can be trusted",
      display: input.health.confidence,
      caveat: input.health.confidenceNote,
    },
    ...input.health.dimensions.map((dimension) => ({
      key: "health_dimension",
      label: dimension.label,
      display:
        dimension.score === null
          ? `not scored (${dimension.reason})`
          : `${formatNumber(dimension.score)} out of 100`,
    })),
  ]

  return {
    businessName: input.businessName,
    currency: input.currency,
    periodLabel: input.periodLabel,
    comparisonLabel: input.comparisonLabel,
    scopeLabel: input.scopeLabel,
    channelScoped: input.channelScoped,
    periodIncomplete: input.periodIncomplete,
    headline,
    changes,
    channels,
    products,
    quality,
    health,
    insights: input.insights,
  }
}

/**
 * Renders the sheet as the text the model actually receives.
 *
 * This exact string is also what `guard.ts` builds its allowlist from, which
 * is the neat part: whatever numbers we showed the model, it may repeat.
 * Anything else it says is, by definition, a number we never gave it.
 */
export function renderFactSheet(sheet: FactSheet): string {
  const lines: string[] = []

  lines.push(`BUSINESS: ${sheet.businessName}`)
  lines.push(`CURRENCY: ${sheet.currency} (every figure below is in this currency)`)
  lines.push(`PERIOD: ${sheet.periodLabel}`)
  lines.push(`COMPARED WITH: ${sheet.comparisonLabel}`)
  lines.push(`THESE FIGURES COVER: ${sheet.scopeLabel}`)

  if (sheet.channelScoped) {
    lines.push(
      "NOTE: a channel filter is on. Expenses and net profit belong to the " +
        "whole business and are never split across channels, so they appear " +
        "below as not calculated. Do not describe this channel as profitable " +
        "or unprofitable after expenses -- only gross profit is known for it."
    )
  }

  if (sheet.periodIncomplete) {
    lines.push(
      "NOTE: this period is still running, so it is being compared against a " +
        "complete one. Comparisons will look weaker than they are."
    )
  }

  const section = (title: string, facts: Fact[]) => {
    if (facts.length === 0) return
    lines.push("", `## ${title}`)
    for (const item of facts) {
      lines.push(`- ${item.label}: ${item.display}`)
      if (item.definition) lines.push(`    means: ${item.definition}`)
      if (item.caveat) lines.push(`    RELIABILITY: ${item.caveat}`)
    }
  }

  section("Headline figures", sheet.headline)
  section("Change against the previous period", sheet.changes)
  section("Channels", sheet.channels)
  section("Products", sheet.products)
  section("How reliable these figures are", sheet.quality)
  section("Health", sheet.health)

  if (sheet.insights.length > 0) {
    lines.push("", "## Findings BizMind has already established")
    lines.push(
      "These were produced by arithmetic, not by judgement. Treat each as true.",
      ""
    )
    for (const insight of sheet.insights) {
      lines.push(`- [${insight.severity}] ${insight.title}`)
      lines.push(`    ${insight.summary}`)
      lines.push(`    impact: ${insight.businessImpact}`)
      lines.push(`    suggested next step: ${insight.recommendedNextStep}`)
      for (const metric of insight.supportingMetrics) {
        lines.push(`    ${metric.label}: ${metric.value}`)
      }
    }
  }

  return lines.join("\n")
}
