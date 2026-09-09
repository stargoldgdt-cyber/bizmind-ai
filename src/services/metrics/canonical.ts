/**
 * The canonical BizMind vocabulary.
 *
 * FLEXIBLE SOURCE FIELDS. STANDARD BIZMIND MEANING.
 *
 * Every business names things differently. One seller's spreadsheet says
 * "Product Wholesale Price", another says "Landed Cost", a third says "COGS".
 * BizMind does not ask anyone to rename their columns. It asks, once, what a
 * column means -- and from then on there is exactly one internal name for that
 * concept, defined here.
 *
 * This file is the authority. `METRICS` in the analytics service is BUILT from
 * it rather than restating it, so a metric cannot come to mean two things in
 * two places.
 *
 * THE RULE THAT MATTERS MOST
 * --------------------------
 * A metric marked `computed` can never be filled in from a source column. It
 * is calculated by the analytics engine from figures BizMind has verified.
 *
 * This is not tidiness. A marketplace's own "Profit/Loss" column looks exactly
 * like net profit and is not: it is built from whatever that seller put in
 * their cost column, and it excludes every expense the marketplace never saw.
 * Letting a source figure occupy a computed metric would let it inherit the
 * credibility of a number BizMind actually checked.
 */

/** What kind of quantity a metric is. Decides formatting, never arithmetic. */
export type MetricKind = "money" | "ratio" | "count" | "quantity"

/**
 * Where a metric's value is allowed to come from.
 *
 * `sourced`   -- a confirmed source column may supply it.
 * `computed`  -- the analytics engine calculates it. No source may supply it.
 */
export type MetricOrigin = "sourced" | "computed"

export type CanonicalMetric = {
  /** The stable internal identity. Never changes, never localised. */
  key: string
  label: string
  kind: MetricKind
  origin: MetricOrigin
  /** What the figure is, in the owner's language. */
  definition: string
  /** Whether a rising number is good. Fees and refunds rising is not. */
  higherIsBetter: boolean
  /** What can make this figure unreliable. */
  caveat?: string
  /**
   * The column name this metric carries in the analytics functions, where one
   * exists. Present only for metrics the dashboard publishes today.
   */
  analyticsKey?: string
}

/**
 * The vocabulary.
 *
 * Order is deliberate: money in, cost out, what is left, then the counts and
 * the coverage figures that say how much of it can be trusted.
 */
export const CANONICAL_METRICS: Record<string, CanonicalMetric> = {
  /* ---- Money coming in --------------------------------------------------- */
  revenue: {
    key: "revenue",
    label: "Revenue",
    kind: "money",
    origin: "sourced",
    definition:
      "Total of all orders placed in the period, excluding cancelled orders. Includes shipping and tax as charged to the customer.",
    higherIsBetter: true,
    analyticsKey: "revenue",
  },
  payment_received: {
    key: "payment_received",
    label: "Payment received",
    kind: "money",
    origin: "sourced",
    definition:
      "What a marketplace or processor actually paid out for the period, after their own deductions. Not the same as revenue.",
    higherIsBetter: true,
    caveat:
      "A payout is what reached the bank, not what was earned. Timing differences between the two are normal.",
  },

  /* ---- Cost of the goods themselves -------------------------------------- */
  cogs: {
    key: "cogs",
    label: "Cost of goods",
    kind: "money",
    origin: "sourced",
    definition:
      "Quantity multiplied by the cost recorded on each order line at the time of sale, added up. Lines with no recorded cost contribute nothing.",
    higherIsBetter: false,
    caveat:
      "Understated when any order line has no recorded cost. Check cost coverage.",
    analyticsKey: "cogs",
  },

  /* ---- Costs of selling -------------------------------------------------- */
  marketplace_fees: {
    key: "marketplace_fees",
    label: "Channel fees",
    kind: "money",
    origin: "sourced",
    definition:
      "Marketplace commission, payment processing and fulfilment charges recorded against orders in the period.",
    higherIsBetter: false,
    caveat:
      "A fee the source never recorded is stored as unknown, not zero. Check fee coverage.",
    analyticsKey: "fees",
  },
  advertising_cost: {
    key: "advertising_cost",
    label: "Advertising",
    kind: "money",
    origin: "sourced",
    definition: "Money spent on ads, sponsored placements and paid promotion.",
    higherIsBetter: false,
    caveat:
      "Marketplaces often settle advertising in a separate report, so a blank column usually means 'not in this file', not 'nothing was spent'.",
  },
  shipping_expense: {
    key: "shipping_expense",
    label: "Shipping cost",
    kind: "money",
    origin: "sourced",
    definition: "What it cost to deliver goods, as opposed to what was charged for delivery.",
    higherIsBetter: false,
    caveat:
      "Shipping charged to the customer and shipping paid to a carrier are different figures that often share a column name.",
  },
  storage_cost: {
    key: "storage_cost",
    label: "Storage",
    kind: "money",
    origin: "sourced",
    definition: "Warehousing and long-term storage charges for held inventory.",
    higherIsBetter: false,
  },
  promotional_rebates: {
    key: "promotional_rebates",
    label: "Promotions",
    kind: "money",
    origin: "sourced",
    definition:
      "Discounts and rebates funded by the seller rather than by the marketplace.",
    higherIsBetter: false,
  },
  refunds: {
    key: "refunds",
    label: "Refunds",
    kind: "money",
    origin: "sourced",
    definition: "Value of returns approved, received or refunded in the period.",
    higherIsBetter: false,
    analyticsKey: "refunds",
  },
  other_expenses: {
    key: "other_expenses",
    label: "Other charges",
    kind: "money",
    origin: "sourced",
    definition:
      "Charges the source did not put in any named category. Kept separate so an uncategorised amount is never quietly folded into a named one.",
    higherIsBetter: false,
  },
  operating_expenses: {
    key: "operating_expenses",
    label: "Expenses",
    kind: "money",
    origin: "sourced",
    definition: "Operating costs recorded against the period.",
    higherIsBetter: false,
    analyticsKey: "expenses",
  },
  total_expense: {
    key: "total_expense",
    label: "Total charges",
    kind: "money",
    origin: "sourced",
    definition:
      "A source's own total of everything it deducted for the period. Preserved as the source stated it, so its arithmetic can be checked rather than assumed.",
    higherIsBetter: false,
    caveat:
      "A source total is not a BizMind total. It contains only what that source knows about, which is never every cost the business has.",
  },

  /* ---- What is left. Calculated, never imported. ------------------------- */
  gross_profit: {
    key: "gross_profit",
    label: "Gross profit",
    kind: "money",
    origin: "computed",
    definition: "Revenue minus cost of goods minus channel fees.",
    higherIsBetter: true,
    caveat: "Overstated when cost coverage is below 100%.",
    analyticsKey: "gross_profit",
  },
  gross_margin: {
    key: "gross_margin",
    label: "Gross margin",
    kind: "ratio",
    origin: "computed",
    definition:
      "Gross profit as a percentage of revenue. Not calculated when there is no revenue.",
    higherIsBetter: true,
    caveat: "Overstated when cost coverage is below 100%.",
    analyticsKey: "gross_margin",
  },
  net_profit: {
    key: "net_profit",
    label: "Net profit",
    kind: "money",
    origin: "computed",
    definition: "Gross profit minus operating expenses.",
    higherIsBetter: true,
    caveat: "Overstated when cost coverage is below 100%.",
    analyticsKey: "net_profit",
  },
  net_margin: {
    key: "net_margin",
    label: "Net margin",
    kind: "ratio",
    origin: "computed",
    definition: "Net profit as a percentage of revenue.",
    higherIsBetter: true,
    analyticsKey: "net_margin",
  },

  /* ---- Counts ------------------------------------------------------------ */
  orders: {
    key: "orders",
    label: "Orders",
    kind: "count",
    origin: "sourced",
    definition: "Orders placed in the period, excluding cancelled ones.",
    higherIsBetter: true,
    analyticsKey: "orders_count",
  },
  units: {
    key: "units",
    label: "Units sold",
    kind: "quantity",
    origin: "sourced",
    definition: "Total quantity across all order lines in the period.",
    higherIsBetter: true,
    analyticsKey: "units_sold",
  },
  customers: {
    key: "customers",
    label: "Customers who ordered",
    kind: "count",
    origin: "computed",
    definition:
      "Distinct customers with at least one order. Orders with no customer attached are not counted.",
    higherIsBetter: true,
    analyticsKey: "customers_count",
  },
  aov: {
    key: "aov",
    label: "Average order value",
    kind: "money",
    origin: "computed",
    definition: "Revenue divided by the number of orders.",
    higherIsBetter: true,
    analyticsKey: "avg_order_value",
  },

  /* ---- How much of the above can be trusted ------------------------------ */
  cost_coverage: {
    key: "cost_coverage",
    label: "Cost coverage",
    kind: "ratio",
    origin: "computed",
    definition:
      "The share of order lines that have a recorded cost. Below 100% means profit and margin are overstated by an unknown amount.",
    higherIsBetter: true,
    analyticsKey: "cost_coverage",
  },
  fee_coverage: {
    key: "fee_coverage",
    label: "Fee coverage",
    kind: "ratio",
    origin: "computed",
    definition:
      "The share of orders that have a recorded channel fee. Below 100% means some orders had no fee recorded, so profit and margin are overstated by an unknown amount.",
    higherIsBetter: true,
    analyticsKey: "fee_coverage",
  },
}

export type CanonicalMetricKey = keyof typeof CANONICAL_METRICS

export function getCanonicalMetric(key: string): CanonicalMetric | undefined {
  return CANONICAL_METRICS[key]
}

export function isCanonicalMetric(key: string): boolean {
  return key in CANONICAL_METRICS
}

/**
 * Whether a source column may be mapped onto this metric at all.
 *
 * Returns false for a metric that does not exist, so an unknown key can never
 * be smuggled through as a mapping target.
 */
export function isMappableMetric(key: string): boolean {
  return CANONICAL_METRICS[key]?.origin === "sourced"
}

/** The metrics a source column may legitimately be mapped to. */
export function mappableMetrics(): CanonicalMetric[] {
  return Object.values(CANONICAL_METRICS).filter((m) => m.origin === "sourced")
}

/** The metrics only the analytics engine may produce. */
export function computedMetrics(): CanonicalMetric[] {
  return Object.values(CANONICAL_METRICS).filter((m) => m.origin === "computed")
}
