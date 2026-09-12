/**
 * Analytics types and the metric registry.
 *
 * THE RULE THIS LAYER EXISTS TO ENFORCE
 * -------------------------------------
 * Every money figure below arrives as an EXACT DECIMAL STRING, and the string
 * is the whole point.
 *
 * PostgreSQL holds these as `numeric(20,4)`. Migration 0011 casts them to
 * `text` inside SQL, while they are still exact, so what crosses the wire is
 * `{"revenue":"9550.5000"}` -- quoted, full scale, nothing lost. Before that
 * migration they crossed as unquoted JSON numbers and `JSON.parse` narrowed
 * them to IEEE-754 doubles, which made this very declaration a lie.
 *
 * So `Money = string` is now TRUE at runtime, and it is true because the
 * database says so, not because TypeScript was asked nicely.
 *
 * WHAT THE TYPE DOES AND DOES NOT DO
 * ----------------------------------
 * It does not prevent arithmetic. `a + b` on two strings compiles and returns
 * "10002000". Nothing in the type system stops that, and this file used to
 * claim otherwise.
 *
 * What prevents it is `scripts/verify-money-guard.ts`, which scans the source
 * for arithmetic on a money-named field and fails the build. Comparisons are
 * allowed -- judgement over a figure the database produced. Ordering goes
 * through `compareMoney` in `./money.ts`, which compares digits and converts
 * nothing.
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
  /**
   * Whole-business. NULL under a channel filter: BizMind has no per-channel
   * expense data and never invents an allocation (migration 0025).
   */
  expenses: Money | null
  /** Whole-business, like expenses. NULL under a channel filter. */
  net_profit: Money | null
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
  /**
   * Refunds as a percentage of revenue, computed in SQL.
   *
   * Exists because the insight engine used to work this out in TypeScript and
   * show the result to the owner. A figure somebody reads is a figure the
   * database should have produced.
   */
  refund_rate: Ratio
  /**
   * Order-line value BizMind CALCULATED as quantity x unit price, because the
   * source gave a unit price but no line total. Part of line_revenue, and
   * reported on its own so it is never taken for a figure the source supplied.
   */
  line_revenue_derived: Money
  /** Lines whose value was calculated rather than supplied. */
  items_value_derived: number
  /**
   * Lines with neither a line total nor a unit price. Their value is unknown,
   * so they are left out of line revenue rather than counted as zero.
   */
  items_value_unknown: number
  /** True when the figures cover one channel, or orders with no channel. */
  channel_scoped: boolean
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

/** Where a product's name came from. There is no "(unnamed)". */
export type ProductNameSource = "CATALOGUE" | "ORDER_LINE" | "SKU" | "NONE"

export type ProductPerformance = {
  /** Stable row key: the SKU, else the linked product, else the name, else "unidentified". */
  product_key: string
  product_id: string | null
  sku: string | null
  /** What to call it. Always set; `name_source` says how BizMind knows. */
  product_name: string
  name_source: ProductNameSource
  /**
   * Line revenue over the lines whose value is known (supplied or calculated).
   * NULL when no line's value is known -- never zero.
   */
  revenue: Money | null
  /** The part of revenue calculated as quantity x unit price. */
  revenue_derived: Money
  units_sold: Money
  /** Cost of the measured lines only. */
  cogs: Money
  /** An ALLOCATION of order-level fees by line value, not a measured charge. */
  fees_allocated: Money
  /** NULL when revenue is. */
  gross_profit: Money | null
  gross_margin: Ratio
  orders_count: number
  items_total: number
  /** Lines with a known value -- what revenue, cost and profit are measured over. */
  items_measured: number
  items_value_derived: number
  items_value_unknown: number
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
/* Channel comparison, change drivers, data quality (migration 0026)          */
/* -------------------------------------------------------------------------- */

export type ChangeDirection = "up" | "down" | "flat" | "new" | "gone"

/** One channel, measured against the period before it. */
export type ChannelComparison = {
  channel_id: string | null
  channel_name: string
  channel_type: string
  revenue: Money
  /** Share of this period's revenue. */
  revenue_share: Ratio
  orders_count: number
  units_sold: Money
  avg_order_value: Ratio
  cogs: Money
  fees: Money
  gross_profit: Money
  gross_margin: Ratio
  /** Share of the gross profit the business actually made. NULL when it made none. */
  profit_share: Ratio
  cost_coverage: Ratio
  fee_coverage: Ratio
  previous_revenue: Money
  previous_orders: number
  previous_gross_margin: Ratio
  revenue_change: Money
  revenue_change_pct: Ratio
  orders_change_pct: Ratio
  profit_change: Money
  /** Margin moves in POINTS, never percent: 40% to 30% is ten points down. */
  margin_change_pts: Ratio
  direction: ChangeDirection
}

/** What moved a figure: one channel or one product, for one metric. */
export type ChangeDriver = {
  driver_kind: "CHANNEL" | "PRODUCT"
  driver_key: string
  driver_label: string
  metric: "revenue" | "gross_profit"
  current_value: Money
  previous_value: Money
  change_amount: Money
  /** Share of the total movement of its own kind. */
  share_of_change: Ratio
  direction: "up" | "down" | "flat"
  /** Some of this driver's lines have no recorded value. */
  incomplete: boolean
}

/**
 * What is recorded and what is not, counted.
 *
 * Every dimension is a pair plus a share, so "95.3% cost coverage" can always
 * be stated as "10 of 233 lines have no cost". A coverage with nothing to
 * measure is NULL, never 100%.
 */
export type DataQuality = {
  orders_count: number
  items_total: number
  items_with_cost: number
  items_without_cost: number
  cost_coverage: Ratio
  orders_with_fee: number
  orders_without_fee: number
  fee_coverage: Ratio
  orders_with_channel: number
  orders_without_channel: number
  channel_coverage: Ratio
  orders_with_customer: number
  orders_without_customer: number
  customer_coverage: Ratio
  items_identified: number
  items_without_identity: number
  identity_coverage: Ratio
  items_value_known: number
  items_value_derived: number
  items_value_unknown: number
  value_coverage: Ratio
  products_missing_cost: number
  first_order_at: string | null
  last_order_at: string | null
  days_in_period: number
  days_with_orders: number
  days_since_last_order: number | null
}

/** A gap that can be opened to see the orders behind it. */
export type QualityIssue =
  | "NO_FEE"
  | "NO_CHANNEL"
  | "NO_CUSTOMER"
  | "MISSING_COST"
  | "UNKNOWN_VALUE"
  | "NO_LINES"

export type QualityOrder = {
  order_id: string
  order_number: string | null
  placed_at: string
  channel_name: string | null
  total: Money
  fee_total: Money | null
  items_total: number
  items_without_cost: number
  items_value_unknown: number
  /** How many orders match this gap in total, for paging. */
  matched_count: number
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
