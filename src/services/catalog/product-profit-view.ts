import { compareMoney } from "@/services/analytics/money"
import type { Database } from "@/types/database"

/**
 * How the product profitability screens group, rank and describe products.
 *
 * NOTHING HERE CALCULATES MONEY. Every figure arrives from pnl_by_product() as
 * exact decimal text and leaves unchanged. This module only
 *
 *   - puts a product in a group by comparing its already-final margin with a
 *     fixed line (`compareMoney` compares the digits; no number conversion),
 *   - orders products with the same comparison, and
 *   - counts them.
 *
 * The recommendations are fixed sentences chosen by group. They never contain
 * a figure of their own, so they cannot be wrong about one. (CLAUDE.md §5: a
 * model or a rule may explain a number; it may not produce one.)
 *
 * The dashboard's product card and the Product profitability page both use
 * this file, so "low margin" means the same thing on both.
 */

export type ProfitRow = Database["public"]["Functions"]["pnl_by_product"]["Returns"][number]

/** Margins below this are "low margin"; below zero is a loss. Percent, as text. */
export const LOW_MARGIN_BELOW = "5"
/** Margins at or above this are "high margin". */
export const HIGH_MARGIN_FROM = "25"

export type ProfitStatus =
  | "LOSS"
  | "LOW_MARGIN"
  | "GOOD"
  | "HIGH_MARGIN"
  | "REFUNDED"
  | "MISSING_COST"
  | "NEEDS_MAPPING"

export const STATUS_LABEL: Record<ProfitStatus, string> = {
  LOSS: "Loss",
  LOW_MARGIN: "Low margin",
  GOOD: "Good",
  HIGH_MARGIN: "High margin",
  REFUNDED: "Refunded",
  MISSING_COST: "Missing cost",
  NEEDS_MAPPING: "Needs mapping",
}

/**
 * Which group a row belongs to, or null for the lines the marketplace did not
 * attribute to any product (they are shown apart, never as a product).
 */
export function statusOf(row: ProfitRow): ProfitStatus | null {
  if (row.row_kind === "NOT_ALLOCATED") return null
  if (row.row_kind === "UNMAPPED_SKU") return "NEEDS_MAPPING"
  return statusOfFigures({
    cogsStatus: row.cogs_status,
    margin: row.gross_margin_percent,
    grossProfit: row.gross_profit,
    netSales: row.net_sales,
  })
}

/**
 * Whether a row is a real sale in the period: units were sold AND something was kept after refunds and
 * discounts. A row with no net sales is a refund (or a sale refunded in full), whose amounts are the
 * marketplace's fees and the returned cost, not a product that sells badly.
 */
export function hasRealSales(row: Pick<ProfitViewRow, "units" | "netSales">): boolean {
  return compareMoney(row.units, "0") > 0 && compareMoney(row.netSales, "0") > 0
}

/**
 * The same grouping from a product's own figures, for the product analysis
 * page, which gets them from product_analysis() rather than a table row.
 */
export function statusOfFigures(figures: {
  cogsStatus: string
  margin: string | null
  grossProfit: string | null
  /** Net sales after refunds and discounts. When it is zero or less, nothing was kept: the group is "Refunded". */
  netSales?: string
}): ProfitStatus {
  if (figures.cogsStatus !== "COSTED") return "MISSING_COST"

  // Nothing was kept from the sales: whatever the profit looks like comes from refunds (the marketplace keeps
  // its fees), not from the price or the product's cost. It is not a "loss-making" product and not a leak.
  if (figures.netSales !== undefined && compareMoney(figures.netSales, "0") <= 0) return "REFUNDED"

  // Costed, but a margin does not exist when net sales are zero (everything
  // refunded). The sign of the gross profit still says which side it is on.
  if (figures.margin === null) {
    return figures.grossProfit !== null && compareMoney(figures.grossProfit, "0") < 0 ? "LOSS" : "GOOD"
  }

  const margin = figures.margin
  if (compareMoney(margin, "0") < 0) return "LOSS"
  if (compareMoney(margin, LOW_MARGIN_BELOW) < 0) return "LOW_MARGIN"
  if (compareMoney(margin, HIGH_MARGIN_FROM) >= 0) return "HIGH_MARGIN"
  return "GOOD"
}

const RECOMMENDATION: Record<ProfitStatus, string> = {
  LOSS: "Costs outweigh what it sells for. Review the selling price or the cost of goods.",
  LOW_MARGIN: "The margin is thin. Check whether the price can rise or the cost can fall.",
  GOOD: "A healthy margin. Keep it in stock and watch the marketplace costs.",
  HIGH_MARGIN: "A strong margin. Worth promoting and keeping in stock.",
  REFUNDED: "Every sale was refunded, so only the marketplace's fees remain. Check why customers returned it.",
  MISSING_COST: "Add this product's cost for the sale dates so its profit can be worked out.",
  NEEDS_MAPPING: "Match this SKU to a product so it gets a cost and a margin.",
}

export type ProfitAction = { label: string; href: string }

/** The account and month the table is showing, so the analysis page opens on the same ones. */
export type ProfitScope = { account: string; month: string }

/** Where a product's analysis lives. Link target only; nothing is worked out. */
export function analysisHref(productId: string, scope: ProfitScope | null): string {
  const query = scope ? `?${new URLSearchParams({ account: scope.account, month: scope.month }).toString()}` : ""
  return `/ledger/products/${productId}${query}`
}

function actionOf(status: ProfitStatus, productId: string | null, scope: ProfitScope | null): ProfitAction {
  const analysis = productId ? analysisHref(productId, scope) : "/catalog#needs-attention"
  // Costs are added where the product's dated costs live.
  const catalog = productId ? `/catalog/products/${productId}` : "/catalog#needs-attention"
  switch (status) {
    case "LOSS":
      return { label: "Review product", href: analysis }
    case "LOW_MARGIN":
      return { label: "Review price", href: analysis }
    case "GOOD":
    case "HIGH_MARGIN":
    case "REFUNDED":
      return { label: "View product", href: analysis }
    case "MISSING_COST":
      return { label: "Add cost", href: catalog }
    case "NEEDS_MAPPING":
      return { label: "Match SKU", href: "/catalog#needs-attention" }
  }
}

/** One product or unmatched SKU, ready to show. Figures are still exact text. */
export type ProfitViewRow = {
  key: string
  kind: "PRODUCT" | "UNMAPPED_SKU"
  productId: string | null
  name: string
  /** The product's own SKU, or the marketplace SKU for an unmatched one. */
  sku: string | null
  category: string | null
  marketplace: string | null
  units: string
  netSales: string
  costs: string
  contribution: string
  cogs: string | null
  grossProfit: string | null
  margin: string | null
  status: ProfitStatus
  highSales: boolean
  recommendation: string
  action: ProfitAction
}

export function buildProfitRows(
  rows: readonly ProfitRow[],
  skuByProductId: ReadonlyMap<string, string | null>,
  scope: ProfitScope | null = null
): ProfitViewRow[] {
  const items = rows.filter(
    (row): row is ProfitRow & { row_kind: "PRODUCT" | "UNMAPPED_SKU" } => row.row_kind !== "NOT_ALLOCATED"
  )

  // "High sales" is the top fifth by net sales (at least one). Ranking compares
  // the digits; counting the fifth is whole-number arithmetic on a row count.
  const ranked = [...items].sort((a, b) => compareMoney(b.net_sales, a.net_sales))
  const topCount = items.length === 0 ? 0 : Math.max(1, Math.ceil(items.length / 5))
  const topKeys = new Set(ranked.slice(0, topCount).map(rowKey))

  return items.map((row) => {
    const status = statusOf(row)!
    const isProduct = row.row_kind === "PRODUCT"
    return {
      key: rowKey(row),
      kind: row.row_kind,
      productId: row.product_id,
      name: isProduct ? (row.product_name ?? "Unnamed product") : (row.raw_sku ?? "Unknown SKU"),
      sku: isProduct ? (row.product_id ? (skuByProductId.get(row.product_id) ?? null) : null) : row.raw_sku,
      category: isProduct ? row.product_category : null,
      marketplace: row.marketplace_code,
      units: row.units_sold,
      netSales: row.net_sales,
      costs: row.costs,
      contribution: row.contribution,
      cogs: row.cogs,
      grossProfit: row.gross_profit,
      margin: row.gross_margin_percent,
      status,
      highSales: topKeys.has(rowKey(row)),
      recommendation: RECOMMENDATION[status],
      action: actionOf(status, row.product_id, scope),
    }
  })
}

function rowKey(row: ProfitRow): string {
  return `${row.row_kind}-${row.product_id ?? ""}-${row.marketplace_code ?? ""}-${row.raw_sku ?? ""}`
}

/* ------------------------------------------------------------------------- */
/* Filters                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Every filter a row can match. "profitable" has no chip of its own (the owner
 * keeps the bar to five), but the health bar's "Good" segment still uses it.
 */
export const FILTER_KEYS = ["all", "loss", "low", "high", "setup", "profitable", "refunded"] as const
export type FilterKey = (typeof FILTER_KEYS)[number]

/** The chips shown above the table, in the owner's order. */
export const FILTER_CHIPS: readonly FilterKey[] = ["all", "loss", "low", "high", "setup"]

export const FILTER_LABEL: Record<FilterKey, string> = {
  all: "All products",
  loss: "Loss-making",
  low: `Low margin (<${LOW_MARGIN_BELOW}%)`,
  high: `High margin (${HIGH_MARGIN_FROM}%+)`,
  setup: "Needs setup",
  profitable: "Profitable",
  refunded: "Refunded",
}

/** "Needs setup" is anything the seller must finish before the profit is final: a missing cost or an unmatched SKU. */
const FILTER_TEST: Record<FilterKey, (row: ProfitViewRow) => boolean> = {
  all: () => true,
  loss: (row) => row.status === "LOSS",
  low: (row) => row.status === "LOW_MARGIN",
  high: (row) => row.status === "HIGH_MARGIN",
  setup: (row) => row.status === "MISSING_COST" || row.status === "NEEDS_MAPPING",
  profitable: (row) => row.status === "LOW_MARGIN" || row.status === "GOOD" || row.status === "HIGH_MARGIN",
  refunded: (row) => row.status === "REFUNDED",
}

export function matchesFilter(row: ProfitViewRow, filter: FilterKey): boolean {
  return FILTER_TEST[filter](row)
}

export function filterCounts(rows: readonly ProfitViewRow[]): Record<FilterKey, number> {
  const counts = {} as Record<FilterKey, number>
  for (const key of FILTER_KEYS) counts[key] = rows.filter(FILTER_TEST[key]).length
  return counts
}

/* ------------------------------------------------------------------------- */
/* Top lists, attention and insights                                          */
/* ------------------------------------------------------------------------- */

/** Costed products that made money, most gross profit first. */
export function topProfitable(rows: readonly ProfitViewRow[], limit = 5): ProfitViewRow[] {
  return rows
    .filter((row) => row.grossProfit !== null && compareMoney(row.grossProfit, "0") > 0)
    .sort((a, b) => compareMoney(b.grossProfit!, a.grossProfit!))
    .slice(0, limit)
}

/**
 * Products that SELL but lose money or earn very little, largest loss first. Only real sales qualify (units sold
 * and net sales above zero): a refund-only product, or one whose every sale was refunded, is shown as "Refunded"
 * and never here, and neither are fees, expenses or other lines no product owns (they are not rows at all).
 */
export function biggestLeaks(rows: readonly ProfitViewRow[], limit = 5): ProfitViewRow[] {
  return rows
    .filter(
      (row) =>
        row.kind === "PRODUCT" &&
        hasRealSales(row) &&
        (row.status === "LOSS" || row.status === "LOW_MARGIN") &&
        row.grossProfit !== null
    )
    .sort((a, b) => compareMoney(a.grossProfit!, b.grossProfit!))
    .slice(0, limit)
}

export type Attention = {
  /** Products that lose money or earn under the low-margin line. */
  needAttention: number
  loss: number
  lowMarginHighSales: number
  missingCost: number
  needsMapping: number
  /** Products with no net sales in the period (every sale refunded, or only refunds). Not a product problem. */
  refunded: number
}

export function attentionOf(rows: readonly ProfitViewRow[]): Attention {
  const loss = rows.filter((row) => row.status === "LOSS").length
  const low = rows.filter((row) => row.status === "LOW_MARGIN").length
  return {
    needAttention: loss + low,
    loss,
    lowMarginHighSales: rows.filter((row) => row.highSales && (row.status === "LOW_MARGIN" || row.status === "LOSS")).length,
    missingCost: rows.filter((row) => row.status === "MISSING_COST").length,
    needsMapping: rows.filter((row) => row.status === "NEEDS_MAPPING").length,
    refunded: rows.filter((row) => row.status === "REFUNDED").length,
  }
}

export type Insight = { tone: "danger" | "warning" | "success" | "info"; title: string; body: string }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Observations drawn from the figures already on the page. The only numbers
 * quoted are a single row's own figures, passed through `money` / `percent`;
 * nothing is added up. Called an insight, not "AI": no model writes these.
 */
export function insightsOf(
  rows: readonly ProfitViewRow[],
  money: (value: string) => string,
  percent: (value: string) => string
): Insight[] {
  const out: Insight[] = []
  const attention = attentionOf(rows)
  const leaks = biggestLeaks(rows)

  if (attention.loss > 0) {
    const worst = leaks.find((row) => row.status === "LOSS")
    out.push({
      tone: "danger",
      title: `${plural(attention.loss, "product is", "products are")} losing money`,
      body: worst
        ? `The biggest loss is ${worst.name}, at ${money(worst.grossProfit!)} gross profit. Review its price or its cost.`
        : "Review their prices or their costs.",
    })
  }

  if (attention.lowMarginHighSales > 0) {
    const names = rows
      .filter((row) => row.highSales && (row.status === "LOW_MARGIN" || row.status === "LOSS"))
      .slice(0, 2)
      .map((row) => row.name)
    out.push({
      tone: "warning",
      title: `${plural(attention.lowMarginHighSales, "high-selling product has", "high-selling products have")} a low margin`,
      body: `They sell well but earn little: ${names.join(", ")}${attention.lowMarginHighSales > names.length ? " and more" : ""}. A small price or cost change here moves profit the most.`,
    })
  }

  const best = topProfitable(rows, 1)[0]
  if (best) {
    out.push({
      tone: "success",
      title: `${best.name} made the most profit`,
      body: `${money(best.grossProfit!)} gross profit${best.margin ? ` at a ${percent(best.margin)} margin` : ""}. Keep it in stock.`,
    })
  }

  if (attention.refunded > 0) {
    out.push({
      tone: "info",
      title: `${plural(attention.refunded, "product had", "products had")} no net sales`,
      body: "Every sale was refunded, so only marketplace fees remain. They are listed as Refunded, not as losses, and the fees stay in the Marketplace P&L.",
    })
  }

  const setup = attention.missingCost + attention.needsMapping
  if (setup > 0) {
    out.push({
      tone: "info",
      title: `${plural(setup, "product still needs", "products still need")} setting up`,
      body: "Their profit is not shown until each has a matched SKU and a cost for its sale dates.",
    })
  }

  return out
}
