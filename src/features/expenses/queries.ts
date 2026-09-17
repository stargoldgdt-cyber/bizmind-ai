import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { LedgerMonth } from "@/services/ledger/period"
import type { Database, ExpenseCategory, ExpenseCategoryRule } from "@/types/database"

/**
 * Reads for operating expenses and Net Profit (GCC Phase 7), through the
 * signed-in user's session. Every figure arrives from SQL as exact text.
 */

type Fn = Database["public"]["Functions"]
export type NetProfitRow = Fn["pnl_net_profit"]["Returns"][number]
export type ExpenseBreakdownRow = Fn["expense_breakdown"]["Returns"][number]
export type ExpenseQueueRow = Fn["expense_category_queue"]["Returns"][number]
export type ExpensePeriodRow = Fn["expense_periods"]["Returns"][number]

/** Net Profit for one currency and month, or null when the business has nothing in it. */
export async function getNetProfit(businessId: string, currency: string, month: LedgerMonth): Promise<NetProfitRow | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("pnl_net_profit", {
    p_from: month.from,
    p_to: month.to,
    p_business_id: businessId,
  })
  if (error) throw new Error(`Could not load net profit: ${error.message}`)
  return (data ?? []).find((row) => row.currency === currency) ?? null
}

export async function getNetProfitAll(businessId: string, month: LedgerMonth): Promise<NetProfitRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("pnl_net_profit", {
    p_from: month.from,
    p_to: month.to,
    p_business_id: businessId,
  })
  if (error) throw new Error(`Could not load net profit: ${error.message}`)
  return data ?? []
}

export async function getExpenseBreakdown(businessId: string, month: LedgerMonth): Promise<ExpenseBreakdownRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("expense_breakdown", {
    p_from: month.from,
    p_to: month.to,
    p_business_id: businessId,
  })
  if (error) throw new Error(`Could not load expenses: ${error.message}`)
  return data ?? []
}

export async function getExpensePeriods(businessId: string): Promise<ExpensePeriodRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("expense_periods", { p_business_id: businessId })
  if (error) throw new Error(`Could not load the months with expenses: ${error.message}`)
  return data ?? []
}

export async function getExpenseQueue(businessId: string): Promise<ExpenseQueueRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("expense_category_queue", { p_business_id: businessId })
  if (error) throw new Error(`Could not load the expense categories to classify: ${error.message}`)
  return data ?? []
}

export async function listExpenseCategories(): Promise<ExpenseCategory[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("expense_categories")
    .select("code, label, cost_class, explanation, sort_order")
    .order("sort_order")
  if (error) throw new Error(`Could not load the expense categories: ${error.message}`)
  return (data ?? []) as ExpenseCategory[]
}

/** The category names this business classified itself. */
export async function listBusinessExpenseRules(businessId: string): Promise<ExpenseCategoryRule[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("expense_category_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("status", "ACTIVE")
    .order("created_at", { ascending: false })
  if (error) throw new Error(`Could not load your expense classifications: ${error.message}`)
  return (data ?? []) as ExpenseCategoryRule[]
}
