import "server-only"

import { createClient } from "@/lib/supabase/server"

import {
  periodBounds,
  type ChannelPerformance,
  type DashboardSummary,
} from "./types"

/**
 * Reading computed metrics.
 *
 * These call SQL functions rather than pulling rows and adding them up here.
 * The database does the arithmetic exactly, in `numeric`, and Row Level
 * Security applies inside the function — a caller asking about a business they
 * do not belong to receives zeros.
 */

/** An empty result, used when a business genuinely has no data yet. */
const EMPTY_SUMMARY: DashboardSummary = {
  revenue: "0",
  order_count: 0,
  units_sold: "0",
  cogs: "0",
  fees: "0",
  gross_profit: "0",
  gross_margin: null,
  expenses: "0",
  net_profit: "0",
  net_margin: null,
  avg_order_value: null,
  customer_count: 0,
  refunds: "0",
  items_total: 0,
  items_with_cost: 0,
}

export type DashboardData = {
  current: DashboardSummary
  previous: DashboardSummary
  channels: ChannelPerformance[]
  /** Set when a metric call failed, so the page can say so instead of showing zeros. */
  error: string | null
}

/**
 * Everything the dashboard needs, for a period and the one before it.
 *
 * On failure this returns an `error` rather than throwing or quietly
 * substituting zeros. A business owner seeing "0" when the truth is "we could
 * not calculate this" would make decisions on a number that does not exist.
 */
export async function getDashboardData(
  businessId: string,
  days: number
): Promise<DashboardData> {
  const supabase = await createClient()
  const { from, to, previousFrom, previousTo } = periodBounds(days)

  const [current, previous, channels] = await Promise.all([
    supabase.rpc("dashboard_summary", {
      p_business_id: businessId,
      p_from: from,
      p_to: to,
    }),
    supabase.rpc("dashboard_summary", {
      p_business_id: businessId,
      p_from: previousFrom,
      p_to: previousTo,
    }),
    supabase.rpc("channel_performance", {
      p_business_id: businessId,
      p_from: from,
      p_to: to,
    }),
  ])

  const failure = current.error ?? previous.error ?? channels.error

  if (failure) {
    return {
      current: EMPTY_SUMMARY,
      previous: EMPTY_SUMMARY,
      channels: [],
      error: failure.message,
    }
  }

  // The functions return a single row; Supabase gives it back as an array.
  const currentRow = (current.data as DashboardSummary[] | null)?.[0]
  const previousRow = (previous.data as DashboardSummary[] | null)?.[0]

  return {
    current: currentRow ?? EMPTY_SUMMARY,
    previous: previousRow ?? EMPTY_SUMMARY,
    channels: (channels.data as ChannelPerformance[] | null) ?? [],
    error: null,
  }
}
