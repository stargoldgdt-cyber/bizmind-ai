import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { MetricGroup } from "@/services/classification/model"
import type {
  LedgerQualityRow,
  PnlBreakdownRow,
  PnlSettlementRow,
  PnlSummaryRow,
} from "@/services/ledger/export"
import type { LedgerMonth } from "@/services/ledger/period"
import type { ClassificationCategoryRow, ClassificationRule, Database } from "@/types/database"

/**
 * Reads for the ledger dashboard, all through the signed-in user's session.
 *
 * Row Level Security decides what can be seen; the business and account
 * filters here only choose which of the user's own data a screen shows. Every
 * figure arrives from SQL as exact text and is passed through untouched.
 */

export type LedgerAccount = {
  id: string
  label: string
  marketplace_code: string
  currency: string
  status: "ACTIVE" | "ARCHIVED"
}

export type LedgerPeriod = Database["public"]["Functions"]["pnl_periods"]["Returns"][number]

export async function listLedgerAccounts(businessId: string): Promise<LedgerAccount[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id, label, marketplace_code, currency, status")
    .eq("business_id", businessId)
    .order("label")

  if (error) throw new Error(`Could not load marketplace accounts: ${error.message}`)
  return (data ?? []) as LedgerAccount[]
}

export async function getLedgerPeriods(businessId: string): Promise<LedgerPeriod[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("pnl_periods", { p_business_id: businessId })
  if (error) throw new Error(`Could not load the months with data: ${error.message}`)
  return data ?? []
}

export type LedgerMonthData = {
  summary: PnlSummaryRow | null
  breakdown: PnlBreakdownRow[]
  settlements: PnlSettlementRow[]
  quality: LedgerQualityRow[]
}

/** Everything the overview and the export show for one account and month. */
export async function getLedgerMonth(
  businessId: string,
  accountId: string,
  month: LedgerMonth
): Promise<LedgerMonthData> {
  const supabase = await createClient()
  const range = { p_from: month.from, p_to: month.to, p_account_id: accountId }

  const [summary, breakdown, settlements, quality] = await Promise.all([
    supabase.rpc("pnl_summary", range),
    supabase.rpc("pnl_breakdown", range),
    supabase.rpc("pnl_settlements", range),
    supabase.rpc("ledger_data_quality", { ...range, p_business_id: businessId }),
  ])

  for (const reply of [summary, breakdown, settlements, quality]) {
    if (reply.error) throw new Error(`Could not load this month's figures: ${reply.error.message}`)
  }

  return {
    summary: summary.data?.[0] ?? null,
    breakdown: breakdown.data ?? [],
    settlements: settlements.data ?? [],
    quality: quality.data ?? [],
  }
}

export type CurrencyMonthData = {
  /** All the business's accounts in the currency, added up in SQL. */
  total: PnlSummaryRow | null
  /** The same figures for each of those accounts, for comparison. */
  perAccount: PnlSummaryRow[]
}

/** One month for every account in one currency. Never across currencies (A12). */
export async function getCurrencyMonth(
  businessId: string,
  currency: string,
  month: LedgerMonth
): Promise<CurrencyMonthData> {
  const supabase = await createClient()
  const range = { p_from: month.from, p_to: month.to, p_business_id: businessId }

  const [total, perAccount] = await Promise.all([
    supabase.rpc("pnl_summary", { ...range, p_combine_by_currency: true }),
    supabase.rpc("pnl_summary", range),
  ])

  for (const reply of [total, perAccount]) {
    if (reply.error) throw new Error(`Could not load this month's figures: ${reply.error.message}`)
  }

  return {
    total: (total.data ?? []).find((row) => row.currency === currency) ?? null,
    perAccount: (perAccount.data ?? []).filter((row) => row.currency === currency),
  }
}

/** Every open data-quality item in the business, all periods. */
export async function getBusinessDataQuality(businessId: string): Promise<LedgerQualityRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("ledger_data_quality", { p_business_id: businessId })
  if (error) throw new Error(`Could not load data quality: ${error.message}`)
  return data ?? []
}

export async function listCategories(): Promise<ClassificationCategoryRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("classification_categories")
    .select("code, financial_type, label, default_treatment, metric_group, sort_order")
    .order("sort_order")
  if (error) throw new Error(`Could not load the classification model: ${error.message}`)
  return data ?? []
}

/** The codes this business classified itself (B2 amended). */
export async function listBusinessClassifications(businessId: string): Promise<ClassificationRule[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("classification_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("status", "ACTIVE")
    .order("created_at", { ascending: false })
  if (error) throw new Error(`Could not load your classifications: ${error.message}`)
  return data ?? []
}

/* ---- The lines behind a figure ----------------------------------------- */

export const LINES_PAGE_SIZE = 50

export type LedgerLineFilter =
  | { kind: "all" }
  | { kind: "profit" }
  | { kind: "group"; group: MetricGroup }
  | { kind: "category"; category: string; subcategory: string | null }
  | { kind: "unknown"; matchKey: string | null }
  | { kind: "review" }
  | { kind: "vat-unresolved" }

const LINE_COLUMNS =
  "id, posted_at, source_file_id, source_type, source_subtype, source_description, match_key, " +
  "financial_type, category, category_label, subcategory, pnl_treatment, classification_status, " +
  "amount, currency, order_ref, raw_sku"

export type LedgerLineRow = Pick<
  Database["public"]["Views"]["ledger_classified_lines"]["Row"],
  | "id" | "posted_at" | "source_file_id" | "source_type" | "source_subtype" | "source_description"
  | "match_key" | "financial_type" | "category" | "category_label" | "subcategory" | "pnl_treatment"
  | "classification_status" | "amount" | "currency" | "order_ref" | "raw_sku"
>

export async function listLedgerLines(
  accountId: string,
  month: LedgerMonth,
  filter: LedgerLineFilter,
  page: number
): Promise<{ rows: LedgerLineRow[]; total: number }> {
  const supabase = await createClient()
  let query = supabase
    .from("ledger_classified_lines")
    .select(LINE_COLUMNS, { count: "exact" })
    .eq("marketplace_account_id", accountId)
    .gte("posted_at", month.from)
    .lt("posted_at", month.to)

  switch (filter.kind) {
    case "profit":
      query = query.in("pnl_treatment", ["INCREASE_REVENUE", "DECREASE_REVENUE", "INCREASE_EXPENSE"])
      break
    case "group":
      query = query.eq("metric_group", filter.group)
      break
    case "category":
      query = query.eq("category", filter.category)
      if (filter.subcategory) query = query.eq("subcategory", filter.subcategory)
      break
    case "unknown":
      query = query.eq("classification_status", "UNKNOWN")
      if (filter.matchKey) query = query.eq("match_key", filter.matchKey)
      break
    case "review":
      query = query.eq("classification_status", "UNDER_REVIEW")
      break
    case "vat-unresolved":
      query = query.eq("pnl_treatment", "CONDITIONAL")
      break
    case "all":
      break
  }

  const first = page * LINES_PAGE_SIZE
  const { data, count, error } = await query
    .order("posted_at")
    .order("id")
    .range(first, first + LINES_PAGE_SIZE - 1)

  if (error) throw new Error(`Could not load the lines: ${error.message}`)
  return { rows: (data ?? []) as unknown as LedgerLineRow[], total: count ?? 0 }
}
