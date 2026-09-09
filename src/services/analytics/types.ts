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
/* Metric registry — the published definitions                                */
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
}

/**
 * Every metric the product publishes, defined once.
 *
 * This is the contract. A number shown anywhere in BizMind must appear here
 * with a definition an owner could check, because a figure nobody can define
 * is a figure nobody should act on.
 */
export const METRICS: Record<string, MetricDefinition> = {
  revenue: {
    key: "revenue",
    label: "Revenue",
    format: "money",
    definition:
      "Total of all orders placed in the period, excluding cancelled orders. Includes shipping and tax as charged to the customer.",
    higherIsBetter: true,
  },
  cogs: {
    key: "cogs",
    label: "Cost of goods",
    format: "money",
    definition:
      "Quantity multiplied by the cost recorded on each order line at the time of sale, added up. Lines with no recorded cost contribute nothing.",
    higherIsBetter: false,
    caveat:
      "Understated when any order line has no recorded cost. Check cost coverage.",
  },
  fees: {
    key: "fees",
    label: "Channel fees",
    format: "money",
    definition:
      "Marketplace commission, payment processing and fulfilment charges recorded against orders in the period.",
    higherIsBetter: false,
    caveat:
      "BizMind cannot tell a genuine zero from a fee that was never recorded.",
  },
  gross_profit: {
    key: "gross_profit",
    label: "Gross profit",
    format: "money",
    definition: "Revenue minus cost of goods minus channel fees.",
    higherIsBetter: true,
    caveat: "Overstated when cost coverage is below 100%.",
  },
  gross_margin: {
    key: "gross_margin",
    label: "Gross margin",
    format: "percent",
    definition:
      "Gross profit as a percentage of revenue. Not calculated when there is no revenue.",
    higherIsBetter: true,
    caveat: "Overstated when cost coverage is below 100%.",
  },
  expenses: {
    key: "expenses",
    label: "Expenses",
    format: "money",
    definition: "Operating costs recorded against the period.",
    higherIsBetter: false,
  },
  net_profit: {
    key: "net_profit",
    label: "Net profit",
    format: "money",
    definition: "Gross profit minus operating expenses.",
    higherIsBetter: true,
    caveat: "Overstated when cost coverage is below 100%.",
  },
  net_margin: {
    key: "net_margin",
    label: "Net margin",
    format: "percent",
    definition: "Net profit as a percentage of revenue.",
    higherIsBetter: true,
  },
  orders_count: {
    key: "orders_count",
    label: "Orders",
    format: "count",
    definition: "Orders placed in the period, excluding cancelled ones.",
    higherIsBetter: true,
  },
  units_sold: {
    key: "units_sold",
    label: "Units sold",
    format: "number",
    definition: "Total quantity across all order lines in the period.",
    higherIsBetter: true,
  },
  avg_order_value: {
    key: "avg_order_value",
    label: "Average order value",
    format: "money",
    definition: "Revenue divided by the number of orders.",
    higherIsBetter: true,
  },
  customers_count: {
    key: "customers_count",
    label: "Customers who ordered",
    format: "count",
    definition:
      "Distinct customers with at least one order. Orders with no customer attached are not counted.",
    higherIsBetter: true,
  },
  refunds: {
    key: "refunds",
    label: "Refunds",
    format: "money",
    definition:
      "Value of returns approved, received or refunded in the period.",
    higherIsBetter: false,
  },
  cost_coverage: {
    key: "cost_coverage",
    label: "Cost coverage",
    format: "percent",
    definition:
      "The share of order lines that have a recorded cost. Below 100% means profit and margin are overstated by an unknown amount.",
    higherIsBetter: true,
  },
}

export function getMetric(key: string): MetricDefinition | undefined {
  return METRICS[key]
}
