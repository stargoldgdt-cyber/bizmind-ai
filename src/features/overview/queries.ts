import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { LedgerMonth } from "@/services/ledger/period"
import type { Database } from "@/types/database"

/**
 * Everything the home dashboard shows, for one currency (or one account) and
 * one month, read through the signed-in user's session. Every figure, share,
 * change and chart position arrives computed by the SQL readers (0043 and the
 * ledger readers they build on). Nothing here calculates.
 */

type Fn = Database["public"]["Functions"]
export type OverviewRow = Fn["dashboard_overview"]["Returns"][number]
export type WaterfallStep = Fn["dashboard_waterfall"]["Returns"][number]
export type DailyPoint = Fn["dashboard_daily"]["Returns"][number]
export type CostRow = Fn["dashboard_cost_breakdown"]["Returns"][number]
export type AccountRow = Fn["dashboard_accounts"]["Returns"][number]
export type ProductRow = Fn["pnl_by_product"]["Returns"][number]
export type PayoutRow = Fn["expected_payouts"]["Returns"][number]

export type OverviewScope = { currency: string; accountId: string | null }

export type OverviewData = {
  overview: OverviewRow | null
  waterfall: WaterfallStep[]
  daily: DailyPoint[]
  costs: CostRow[]
  accounts: AccountRow[]
  products: ProductRow[]
  payouts: PayoutRow[]
}

export async function getOverviewData(businessId: string, scope: OverviewScope, month: LedgerMonth): Promise<OverviewData> {
  const supabase = await createClient()
  const range = {
    p_business_id: businessId,
    p_currency: scope.currency,
    p_from: month.from,
    p_to: month.to,
  }
  const scoped = { ...range, p_account_id: scope.accountId }

  const [overview, waterfall, daily, costs, accounts, products, payouts] = await Promise.all([
    supabase.rpc("dashboard_overview", scoped),
    supabase.rpc("dashboard_waterfall", scoped),
    supabase.rpc("dashboard_daily", scoped),
    supabase.rpc("dashboard_cost_breakdown", scoped),
    supabase.rpc("dashboard_accounts", range),
    supabase.rpc("pnl_by_product", {
      p_from: month.from,
      p_to: month.to,
      p_account_id: scope.accountId,
      p_business_id: businessId,
    }),
    supabase.rpc("expected_payouts", {
      p_business_id: businessId,
      p_from: month.from,
      p_to: month.to,
      p_account_id: scope.accountId,
    }),
  ])

  for (const reply of [overview, waterfall, daily, costs, accounts, products, payouts]) {
    if (reply.error) throw new Error(`Could not load the dashboard: ${reply.error.message}`)
  }

  return {
    overview: overview.data?.[0] ?? null,
    waterfall: waterfall.data ?? [],
    daily: daily.data ?? [],
    costs: costs.data ?? [],
    accounts: accounts.data ?? [],
    products: (products.data ?? []).filter((p) => p.currency === scope.currency),
    payouts: (payouts.data ?? []).filter((p) => p.currency === scope.currency),
  }
}
