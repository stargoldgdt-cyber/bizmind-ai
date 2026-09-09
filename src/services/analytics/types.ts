/**
 * Analytics types and the metric registry.
 *
 * THE RULE THIS LAYER EXISTS TO ENFORCE
 * -------------------------------------
 * Every money figure below arrives from PostgreSQL as a `numeric`, which
 * PostgREST serialises as a STRING to preserve precision. They are typed as
 * strings here on purpose.
 *
 * TypeScript in this service performs NO arithmetic on money. Not sums, not
 * differences, not percentages — period-over-period deltas come from SQL for
 * exactly that reason. What TypeScript does is compare already-computed RATIOS
 * against documented thresholds, which is judgement, not calculation.
 *
 * If you find yourself writing `Number(a) - Number(b)` on a money value, the
 * calculation belongs in `supabase/migrations/0007_analytics_engine.sql`.
 */

import { CANONICAL_METRICS, type MetricKind } from "@/services/metrics/canonical"

/** A `numeric` column. Exact decimal, carried as text. */
export type Money = string

/** A ratio or percentage the database already computed. Null = incalculable. */
export type Ratio = string | null

/* -------------------------------------------------------------------------- */
/* Raw shapes returned by SQL                                                 */
/* -------------------------------------------------------------------------- */

export type Financials = {
  revenue: Money
  cogs: Money
  fees: Money
  gross_profit: Money
  gross_margin: Ratio
  expenses: Money
  net_profit: Money
  net_margin: Ratio
  orders_count: number
  units_sold: Money
  avg_order_value: Ratio
  customers_count: number
  refunds: Money
  returns_count: number
  cancelled_orders: number
  items_total: number
  items_with_cost: number
  cost_coverage: Ratio
  orders_zero_fees: number
  orders_without_channel: number
  line_revenue: Money
  /** Orders whose fees the source never recorded -- not the same as zero fees. */
  orders_fees_unknown: number
  /** Share of orders with a known fee. Below 100 means profit is overstated. */
  fee_coverage: Ratio
  /**
   * Share of order lines with NO recorded cost, computed in SQL.
   *
   * The complement of `cost_coverage`, and it exists as its own figure for a
   * specific reason: the AI layer must never derive one number from another,
   * and "25% of your lines have no cost" is the sentence an owner acts on.
   */
  cost_gap: Ratio
  /** Share of orders with NO recorded fee. Unknown, not zero. */
  fee_gap: Ratio
}

export type MetricDirection = "up" | "down" | "flat" | "unknown"

export type MetricComparison = {
  metric: string
  current_value: Money | null
  previous_value: Money | null
  absolute_change: Money | null
  /** Null when the previous value was zero — a rise from nothing has no percentage. */
  percent_change: Ratio
  direction: MetricDirection
}

export type ChannelPerformance = {
  channel_id: string | null
  channel_name: string
  channel_type: string
  revenue: Money
  cogs: Money
  fees: Money
  gross_profit: Money
  gross_margin: Ratio
  orders_count: number
  units_sold: Money
  avg_order_value: Ratio
  items_total: number
  items_with_cost: number
  cost_coverage: Ratio
  orders_fees_unknown: number
  fee_coverage: Ratio
}

export type ProductPerformance = {
  sku: string
  product_name: string
  revenue: Money
  units_sold: Money
  cogs: Money
  /** An ALLOCATION of order-level fees by line revenue, not a measured charge. */
  fees_allocated: Money
  gross_profit: Money
  gross_margin: Ratio
  orders_count: number
  items_total: number
  items_with_cost: number
  cost_coverage: Ratio
}

export type Reconciliation = {
  order_revenue: Money
  channel_revenue: Money
  /** Must be exactly zero. Anything else is a defect. */
  channel_difference: Money
  line_revenue: Money
  /** Shipping, order-level discounts, and orders with no lines. Expected. */
  order_line_gap: Money
  orders_without_lines: number
}

export type HealthInputs = {
  revenue: Money
  revenue_previous: Money
  revenue_growth_pct: Ratio
  gross_margin: Ratio
  net_margin: Ratio
  cost_coverage: Ratio
  refund_rate: Ratio
  expense_ratio: Ratio
  orders_count: number
  customers_count: number
  repeat_customer_rate: Ratio
  cancelled_rate: Ratio
  orders_without_channel: number
  orders_zero_fees: number
  variants_tracked: number
  variants_out_of_stock: number
  variants_below_reorder: number
  paid_order_value: Money
  unpaid_order_value: Money
  payment_capture_rate: Ratio
}

/* -------------------------------------------------------------------------- */
/* Metric registry — a view of the canonical vocabulary                       */
/* -------------------------------------------------------------------------- */

export type MetricFormat = "money" | "number" | "percent" | "count"

export type MetricDefinition = {
  key: string
  label: string
  format: MetricFormat
  /** How the figure is calculated, in the owner's language. */
  definition: string
  /** Whether a rising number is good. Fees and expenses rising is not. */
  higherIsBetter: boolean
  /** What can make this figure unreliable. */
  caveat?: string
  /** The canonical metric this is a view of. */
  canonicalKey: string
}

const FORMAT_BY_KIND: Record<MetricKind, MetricFormat> = {
  money: "money",
  ratio: "percent",
  count: "count",
  quantity: "number",
}

/**
 * Every metric the dashboard publishes, keyed by its analytics column name.
 *
 * These are NOT separate definitions. They are the canonical vocabulary in
 * `src/services/metrics/canonical.ts`, re-keyed to the column names the SQL
 * functions return. A metric therefore cannot come to mean one thing on the
 * dashboard and another in the mapping layer: there is one definition, and
 * this is a view of it.
 */
export const METRICS: Record<string, MetricDefinition> = buildMetrics()

function buildMetrics(): Record<string, MetricDefinition> {
  const out: Record<string, MetricDefinition> = {}
  for (const metric of Object.values(CANONICAL_METRICS)) {
    const analyticsKey = metric.analyticsKey
    if (analyticsKey === undefined) continue
    out[analyticsKey] = {
      key: analyticsKey,
      label: metric.label,
      format: FORMAT_BY_KIND[metric.kind],
      definition: metric.definition,
      higherIsBetter: metric.higherIsBetter,
      caveat: metric.caveat,
      canonicalKey: metric.key,
    }
  }
  return out
}

export function getMetric(key: string): MetricDefinition | undefined {
  return METRICS[key]
}
