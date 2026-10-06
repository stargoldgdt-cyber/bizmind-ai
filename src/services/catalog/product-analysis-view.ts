import { formatMoney, formatPercent } from "@/lib/format"
import { compareMoney } from "@/services/analytics/money"
import type { ProfitStatus } from "@/services/catalog/product-profit-view"
import type { ProductAnalysis } from "@/services/catalog/product-analysis"

/**
 * What the product analysis page tells the seller to do, and why.
 *
 * NOTHING HERE CALCULATES MONEY. Every figure in a sentence was worked out in
 * SQL by product_analysis() and is only formatted here. The rules compare
 * those figures (`compareMoney` compares the digits, never a converted
 * number) and pick fixed wording. No model writes any of it, so the page
 * calls it "Insights", not AI. (CLAUDE.md §5: compute first, then narrate.)
 *
 * Advertising is never part of a product's figures: marketplaces report it
 * without a SKU, and it is not spread across products (A7). So there is no
 * "review ad spend" action here, and the cost card says why.
 */

/** A cost share of net sales at or above this is called out as high. Percent. */
export const HIGH_COST_SHARE = 50
/** Marketplace costs at or above this share of net sales are called out as significant. Percent. */
export const SIGNIFICANT_FEE_SHARE = 15

export type Priority = "High" | "Medium" | "Low"

export type Reason = {
  key: string
  title: string
  /** The figure behind the reason, already formatted. */
  detail: string
}

export type RecommendedAction = {
  key: string
  title: string
  detail: string
}

export type ProductInsights = {
  priority: Priority
  /** The one-line verdict shown first. */
  headline: string
  /** The sentence under it, with the product's own figures. */
  summary: string
  reasons: Reason[]
  actions: RecommendedAction[]
}

export function priorityOf(status: ProfitStatus): Priority {
  if (status === "LOSS") return "High"
  if (status === "LOW_MARGIN" || status === "MISSING_COST" || status === "NEEDS_MAPPING") return "Medium"
  return "Low"
}

const HEADLINE: Record<ProfitStatus, string> = {
  LOSS: "This product is losing money.",
  LOW_MARGIN: "This product's margin is thin.",
  GOOD: "This product earns a healthy margin.",
  HIGH_MARGIN: "This product earns a strong margin.",
  MISSING_COST: "This product's profit is not final yet.",
  NEEDS_MAPPING: "This SKU is not matched to a product yet.",
}

const BRAND_NAME: Record<string, string> = { AMAZON: "Amazon", NOON: "noon", CARREFOUR: "Carrefour" }
const marketplaceName = (code: string) => BRAND_NAME[code] ?? code

/** Ranks and words the page's insights from the SQL figures. */
export function buildInsights(analysis: ProductAnalysis, status: ProfitStatus): ProductInsights {
  const current = analysis.current
  const currency = analysis.currency
  const priority = priorityOf(status)
  const headline = HEADLINE[status]

  if (!current) {
    return { priority, headline: "No sales for this product in this period.", summary: "Pick another month or marketplace.", reasons: [], actions: [] }
  }

  const summary =
    current.gross_profit !== null && current.margin !== null
      ? `It sold ${formatMoney(current.net_sales, currency)} in this period and made a gross profit of ${formatMoney(current.gross_profit, currency)} (${formatPercent(current.margin)}).`
      : `It sold ${formatMoney(current.net_sales, currency)} in this period. Gross profit needs the product's cost for every unit sold.`

  const price = analysis.price
  // "High" and "significant" are warnings: only a product that needs attention gets them.
  const needsAttention = status === "LOSS" || status === "LOW_MARGIN"
  const reasons: (Reason & { weight: number | null })[] = []

  // Where the money goes: each share is a percentage of net sales from SQL.
  if (current.cogs_pct !== null) {
    const high = needsAttention && current.cogs_pct >= HIGH_COST_SHARE
    reasons.push({
      key: "cogs",
      title: high ? "Product cost is high" : "Product cost",
      detail: `${formatPercent(current.cogs_pct)} of selling price`,
      weight: current.cogs_pct,
    })
  }
  if (current.costs_pct !== null) {
    const significant = needsAttention && current.costs_pct >= SIGNIFICANT_FEE_SHARE
    reasons.push({
      key: "fees",
      title: significant ? "Marketplace costs are significant" : "Marketplace costs",
      detail: `${formatPercent(current.costs_pct)} of selling price`,
      weight: current.costs_pct,
    })
  }
  if (price && compareMoney(price.average_price, price.break_even_price) < 0) {
    reasons.push({
      key: "price",
      title: "Selling price is below break-even",
      detail: `Average ${formatMoney(price.average_price, currency)}, break-even ${formatMoney(price.break_even_price, currency)}`,
      weight: null,
    })
  }
  // Largest cost share first; the price fact, when it applies, leads because
  // it is the one that explains a loss on its own.
  reasons.sort((a, b) => {
    if (a.weight === null) return -1
    if (b.weight === null) return 1
    return a.weight < b.weight ? 1 : a.weight > b.weight ? -1 : 0
  })

  const actions: RecommendedAction[] = []

  if (needsAttention && price?.increase_amount && price.increase_pct !== null && compareMoney(price.increase_amount, "0") > 0) {
    actions.push({
      key: "price",
      title: "Review selling price",
      detail: `Raising the average price by ${formatMoney(price.increase_amount, currency)} (${formatPercent(price.increase_pct)}) would reach a ${price.target_margin}% margin, if marketplace costs per unit stay the same.`,
    })
  }

  if (needsAttention && current.cogs_pct !== null && current.costs_pct !== null && current.cogs_pct > current.costs_pct) {
    actions.push({
      key: "cost",
      title: "Check product cost",
      detail: `Product cost is ${formatPercent(current.cogs_pct)} of the selling price. Check the cost entered, or ask the supplier for a better one.`,
    })
  } else if (needsAttention && current.costs_pct !== null && current.costs_pct >= SIGNIFICANT_FEE_SHARE) {
    actions.push({
      key: "fees",
      title: "Check marketplace costs",
      detail: `Marketplace costs take ${formatPercent(current.costs_pct)} of the selling price. Look at the cost breakdown for the biggest line.`,
    })
  }

  // Compare marketplaces only when two or more have a margin to compare.
  const withMargin = analysis.marketplaces.filter((m) => m.margin !== null)
  if (withMargin.length >= 2) {
    const ranked = [...withMargin].sort((a, b) => compareMoney(b.margin!, a.margin!))
    const best = ranked[0]
    const worst = ranked[ranked.length - 1]
    if (compareMoney(best.margin!, worst.margin!) > 0) {
      actions.push({
        key: "marketplaces",
        title: "Compare marketplaces",
        detail: `Margin is ${formatPercent(best.margin)} on ${marketplaceName(best.marketplace_code)} and ${formatPercent(worst.margin)} on ${marketplaceName(worst.marketplace_code)}.`,
      })
    }
  }

  if (status === "MISSING_COST") {
    actions.push({
      key: "add-cost",
      title: "Add the product cost",
      detail: "Add this product's cost for the sale dates so its gross profit can be worked out.",
    })
  }
  if (!needsAttention && status !== "MISSING_COST" && actions.length === 0) {
    actions.push({
      key: "keep",
      title: status === "HIGH_MARGIN" ? "Worth promoting" : "Keep an eye on it",
      detail: "Nothing needs fixing now. Check back when marketplace costs or the product cost change.",
    })
  }

  return {
    priority,
    headline,
    summary,
    reasons: reasons.map((reason) => ({ key: reason.key, title: reason.title, detail: reason.detail })),
    actions,
  }
}
