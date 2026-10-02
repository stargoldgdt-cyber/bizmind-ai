import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { OverviewPeriod } from "@/services/overview/period"
import type { Database, Json } from "@/types/database"

/**
 * Everything the executive dashboard shows, for one currency (or one account)
 * and one period, read through the signed-in user's session. Every figure,
 * share, change and chart position arrives computed by the SQL readers (0043,
 * 0049 and the ledger readers they build on). Nothing here calculates.
 */

type Fn = Database["public"]["Functions"]
export type OverviewRow = Fn["dashboard_overview"]["Returns"][number]
export type WaterfallStep = Fn["dashboard_waterfall_steps"]["Returns"][number]
export type DailyPoint = Fn["dashboard_daily"]["Returns"][number]
export type MonthlyPoint = Fn["dashboard_monthly"]["Returns"][number]
export type CostRow = Fn["dashboard_cost_breakdown"]["Returns"][number]
export type AccountRow = Fn["dashboard_accounts"]["Returns"][number]
export type ProductRow = Fn["pnl_by_product"]["Returns"][number]
export type PayoutRow = Fn["expected_payouts"]["Returns"][number]
export type BridgeStep = Fn["dashboard_profit_bridge"]["Returns"][number]

export type OverviewScope = { currency: string; accountId: string | null }

export type OverviewData = {
  overview: OverviewRow | null
  waterfall: WaterfallStep[]
  /** Day by day, for a single month only. */
  daily: DailyPoint[]
  /** Month by month and account, for a period of more than one month. */
  monthly: MonthlyPoint[]
  costs: CostRow[]
  accounts: AccountRow[]
  products: ProductRow[]
  payouts: PayoutRow[]
  bridge: BridgeStep[]
}

export async function getOverviewData(
  businessId: string,
  scope: OverviewScope,
  period: OverviewPeriod
): Promise<OverviewData> {
  const supabase = await createClient()
  const range = {
    p_business_id: businessId,
    p_currency: scope.currency,
    p_from: period.from,
    p_to: period.to,
  }
  const scoped = { ...range, p_account_id: scope.accountId }

  const [overview, daily, monthly, costs, accounts, products, payouts] = await Promise.all([
    supabase.rpc("dashboard_overview", scoped),
    period.single ? supabase.rpc("dashboard_daily", scoped) : Promise.resolve({ data: [], error: null }),
    // The trend always shows the whole period's months, so a single month still
    // sits in the context of the months before it.
    supabase.rpc("dashboard_monthly", {
      ...scoped,
      p_from: period.single ? shiftBack(period.from, 11) : period.from,
    }),
    supabase.rpc("dashboard_cost_breakdown", scoped),
    supabase.rpc("dashboard_accounts", range),
    supabase.rpc("pnl_by_product", {
      p_from: period.from,
      p_to: period.to,
      p_account_id: scope.accountId,
      p_business_id: businessId,
    }),
    supabase.rpc("expected_payouts", {
      p_business_id: businessId,
      p_from: period.from,
      p_to: period.to,
      p_account_id: scope.accountId,
    }),
  ])

  for (const reply of [overview, daily, monthly, costs, accounts, products, payouts]) {
    if (reply.error) throw new Error(`Could not load the dashboard: ${reply.error.message}`)
  }

  const row = overview.data?.[0] ?? null
  // The waterfall and the profit bridge are both worked out from the overview
  // row already read (0049, 0064), instead of reading the ledger again for
  // each one -- dashboard_profit_bridge used to call pnl_summary() a second
  // time for the exact same two periods dashboard_overview already computed.
  let waterfall: WaterfallStep[] = []
  let bridge: BridgeStep[] = []
  if (row) {
    const [steps, bridgeSteps] = await Promise.all([
      supabase.rpc("dashboard_waterfall_steps", { p_overview: row as unknown as Json }),
      supabase.rpc("dashboard_profit_bridge", { p_overview: row as unknown as Json }),
    ])
    if (steps.error) throw new Error(`Could not load the dashboard: ${steps.error.message}`)
    if (bridgeSteps.error) throw new Error(`Could not load the dashboard: ${bridgeSteps.error.message}`)
    waterfall = steps.data ?? []
    bridge = bridgeSteps.data ?? []
  }

  return {
    overview: row,
    waterfall,
    daily: daily.data ?? [],
    monthly: monthly.data ?? [],
    costs: costs.data ?? [],
    accounts: accounts.data ?? [],
    products: (products.data ?? []).filter((p) => p.currency === scope.currency),
    payouts: (payouts.data ?? []).filter((p) => p.currency === scope.currency),
    bridge,
  }
}

/** The first instant `months` months before `iso` (calendar arithmetic, UTC). */
function shiftBack(iso: string, months: number): string {
  const d = new Date(iso)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1)).toISOString()
}
