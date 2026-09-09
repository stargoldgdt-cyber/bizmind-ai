import "server-only"

import { createClient } from "@/lib/supabase/server"

import { calculateHealth, type BusinessHealth } from "./health"
import { generateInsights, type Insight } from "./insights"
import type { ResolvedPeriod } from "./periods"
import type {
  ChannelPerformance,
  Financials,
  HealthInputs,
  MetricComparison,
  ProductPerformance,
  Reconciliation,
} from "./types"

/**
 * The analytics service.
 *
 * The ONLY place the application asks for business figures. Nothing above this
 * layer performs a financial calculation — not a page, not a component, not a
 * server action. If a number is needed somewhere, it is added here.
 *
 * TENANT SCOPING
 * --------------
 * `businessId` is never accepted from a request. Callers pass the business
 * they already resolved from the session via `getActiveBusiness()`, which
 * checks real membership. Even if that were bypassed, every SQL function runs
 * SECURITY INVOKER under Row Level Security, so a caller asking about another
 * tenant gets zeros and empty sets rather than data.
 */

export type AnalyticsBundle = {
  period: ResolvedPeriod
  currency: string
  current: Financials
  previous: Financials
  comparisons: MetricComparison[]
  channels: ChannelPerformance[]
  products: ProductPerformance[]
  reconciliation: Reconciliation
  health: BusinessHealth
  insights: Insight[]
  /** Set when a figure could not be produced. Never substitute zeros. */
  error: string | null
}

const EMPTY_FINANCIALS: Financials = {
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
}

const EMPTY_RECONCILIATION: Reconciliation = {
  order_revenue: "0",
  channel_revenue: "0",
  channel_difference: "0",
  line_revenue: "0",
  order_line_gap: "0",
  orders_without_lines: 0,
}

/**
 * Everything the product knows about a business for one period.
 *
 * Issued as a single bundle so every screen shows the SAME numbers. Two pages
 * computing the same metric separately is how dashboards start contradicting
 * each other.
 */
export async function getAnalytics(
  businessId: string,
  period: ResolvedPeriod,
  currency: string,
  options: { productLimit?: number } = {}
): Promise<AnalyticsBundle> {
  const supabase = await createClient()

  const current = { p_business_id: businessId, p_from: period.from, p_to: period.to }
  const previous = {
    p_business_id: businessId,
    p_from: period.previousFrom,
    p_to: period.previousTo,
  }

  const [
    currentResult,
    previousResult,
    comparisonResult,
    channelResult,
    previousChannelResult,
    productResult,
    reconciliationResult,
    healthResult,
  ] = await Promise.all([
    supabase.rpc("analytics_financials", current),
    supabase.rpc("analytics_financials", previous),
    supabase.rpc("analytics_compare", {
      p_business_id: businessId,
      p_from: period.from,
      p_to: period.to,
      p_prev_from: period.previousFrom,
      p_prev_to: period.previousTo,
    }),
    supabase.rpc("analytics_channels", current),
    supabase.rpc("analytics_channels", previous),
    supabase.rpc("analytics_products", { ...current, p_limit: options.productLimit ?? 50 }),
    supabase.rpc("analytics_reconciliation", current),
    supabase.rpc("analytics_health_inputs", {
      p_business_id: businessId,
      p_from: period.from,
      p_to: period.to,
      p_prev_from: period.previousFrom,
      p_prev_to: period.previousTo,
    }),
  ])

  const failure =
    currentResult.error ??
    previousResult.error ??
    comparisonResult.error ??
    channelResult.error ??
    previousChannelResult.error ??
    productResult.error ??
    reconciliationResult.error ??
    healthResult.error

  if (failure) {
    // A failed calculation is reported as such. Returning zeros would let an
    // owner act on a number that does not exist.
    return {
      period,
      currency,
      current: EMPTY_FINANCIALS,
      previous: EMPTY_FINANCIALS,
      comparisons: [],
      channels: [],
      products: [],
      reconciliation: EMPTY_RECONCILIATION,
      health: calculateHealth(emptyHealthInputs()),
      insights: [],
      error: failure.message,
    }
  }

  const currentFinancials = first(currentResult.data as Financials[]) ?? EMPTY_FINANCIALS
  const previousFinancials = first(previousResult.data as Financials[]) ?? EMPTY_FINANCIALS
  const comparisons = (comparisonResult.data as MetricComparison[]) ?? []
  const channels = (channelResult.data as ChannelPerformance[]) ?? []
  const previousChannels = (previousChannelResult.data as ChannelPerformance[]) ?? []
  const products = (productResult.data as ProductPerformance[]) ?? []
  const reconciliation =
    first(reconciliationResult.data as Reconciliation[]) ?? EMPTY_RECONCILIATION
  const healthInputs = first(healthResult.data as HealthInputs[]) ?? emptyHealthInputs()

  const insights = generateInsights({
    current: currentFinancials,
    comparisons: new Map(comparisons.map((c) => [c.metric, c])),
    channels,
    previousChannels,
    products,
    currency,
    periodLabel: period.label,
  })

  return {
    period,
    currency,
    current: currentFinancials,
    previous: previousFinancials,
    comparisons,
    channels,
    products,
    reconciliation,
    health: calculateHealth(healthInputs),
    insights,
    error: null,
  }
}

/** Looks up one comparison without the caller reaching into the array. */
export function findComparison(
  comparisons: MetricComparison[],
  metric: string
): MetricComparison | undefined {
  return comparisons.find((c) => c.metric === metric)
}

function first<T>(rows: T[] | null): T | undefined {
  return rows?.[0]
}

function emptyHealthInputs(): HealthInputs {
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
  }
}

export { calculateHealth } from "./health"
export { generateInsights } from "./insights"
export * from "./periods"
export * from "./types"
export type {
  BusinessHealth,
  HealthDimension,
  HealthStatus,
  SupportingMetric,
} from "./health"
export type { Insight, InsightSeverity } from "./insights"
