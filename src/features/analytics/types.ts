/**
 * Analytics shapes.
 *
 * Every money field arrives from PostgreSQL as a `numeric` and therefore as a
 * STRING. That is deliberate — see `src/types/database.ts`. Do not parse these
 * into numbers to do arithmetic; the database has already done the maths.
 * Parsing is only ever acceptable for formatting a value for display.
 */

export type DashboardSummary = {
  revenue: string
  order_count: number
  units_sold: string
  cogs: string
  fees: string
  gross_profit: string
  /** Null when there was no revenue — no margin exists, rather than zero. */
  gross_margin: string | null
  expenses: string
  net_profit: string
  net_margin: string | null
  avg_order_value: string | null
  customer_count: number
  refunds: string
  /** Order lines in the period, and how many had a recorded cost. */
  items_total: number
  items_with_cost: number
}

export type ChannelPerformance = {
  channel_id: string | null
  channel_name: string
  channel_type: string
  revenue: string
  order_count: number
  cogs: string
  fees: string
  gross_profit: string
  gross_margin: string | null
}

/** The periods a user can look at. Kept short; a date picker comes later. */
export const RANGE_OPTIONS = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
  { value: "365d", label: "Last 12 months", days: 365 },
] as const

export type RangeValue = (typeof RANGE_OPTIONS)[number]["value"]

export const DEFAULT_RANGE: RangeValue = "30d"

export function resolveRange(value: string | undefined): (typeof RANGE_OPTIONS)[number] {
  return RANGE_OPTIONS.find((r) => r.value === value) ?? RANGE_OPTIONS[1]
}

/**
 * The current window and the equally long one immediately before it.
 *
 * Comparing like with like matters: measuring 30 days against the previous 30
 * is meaningful, measuring it against a calendar month is not.
 */
export function periodBounds(days: number, now = new Date()) {
  const to = now
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const previousFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000)

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    previousFrom: previousFrom.toISOString(),
    previousTo: from.toISOString(),
  }
}
