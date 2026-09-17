import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { LedgerMonth } from "@/services/ledger/period"
import type { Database } from "@/types/database"

/**
 * Expected marketplace payouts and cashflow (GCC Phase 8), through the
 * signed-in user's session. Amounts arrive from SQL as exact text.
 */

type Fn = Database["public"]["Functions"]
export type ExpectedPayoutRow = Fn["expected_payouts"]["Returns"][number]
export type ExpectedCashflowRow = Fn["expected_cashflow"]["Returns"][number]

export async function getExpectedPayouts(
  businessId: string,
  month: LedgerMonth | null,
  accountId: string | null
): Promise<ExpectedPayoutRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("expected_payouts", {
    p_business_id: businessId,
    p_from: month?.from ?? null,
    p_to: month?.to ?? null,
    p_account_id: accountId,
  })
  if (error) throw new Error(`Could not load expected payouts: ${error.message}`)
  return data ?? []
}

export async function getExpectedCashflow(businessId: string): Promise<ExpectedCashflowRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("expected_cashflow", { p_business_id: businessId })
  if (error) throw new Error(`Could not load expected cashflow: ${error.message}`)
  return data ?? []
}
