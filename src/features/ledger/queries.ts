import "server-only"

import type { WaterfallStep } from "@/features/overview/queries"
import { createClient } from "@/lib/supabase/server"
import type { MetricGroup } from "@/services/classification/model"
import type {
  LedgerQualityRow,
  PnlBreakdownRow,
  PnlSettlementRow,
  PnlSummaryRow,
} from "@/services/ledger/export"
import type { LedgerMonth } from "@/services/ledger/period"
import type { ClassificationCategoryRow, ClassificationRule, Database, Json } from "@/types/database"

/**
 * One shape for every marketplace's payout (migration 0039/0056): a formal
 * settlement total (Amazon) or a payment the marketplace reports sending
 * directly (noon), never money received. Read here so the Settlements and
 * Reconciliation tabs show something meaningful for every marketplace, not
 * only the ones that file settlement reports.
 */
export type ExpectedPayoutRow = Database["public"]["Functions"]["expected_payouts"]["Returns"][number]

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

/**
 * What every P&L reader needs of a period: an exact range and the words for
 * it. A `LedgerMonth` (services/ledger/period.ts) satisfies this, and so
 * does a `PnlPeriod` (services/ledger/pnl-period.ts, which also covers This
 * Quarter and This Year) -- callers may pass either.
 */
export type LedgerRange = { from: string; to: string; label: string }

/**
 * The waterfall reuses `dashboard_waterfall_steps()` (migration 0049) by
 * reshaping a PnlSummaryRow into the JSON shape it reads -- no arithmetic,
 * only field names, so the bar math is the same code the executive dashboard
 * already runs. `net_available: false` stops it at Gross Profit: Net Profit
 * is business-wide (A7) and stays its own section below.
 */
function pnlWaterfallInput(s: PnlSummaryRow): Record<string, unknown> {
  return {
    has_marketplace_data: true,
    figures_status: s.figures_status,
    gross_sales: s.gross_sales,
    sales_refunds: s.sales_refunds,
    seller_discounts: s.seller_discounts,
    net_sales: s.net_sales,
    other_income: s.other_income,
    marketplace_fees: s.marketplace_fees,
    fulfillment: s.fulfillment,
    advertising: s.advertising,
    other_marketplace_costs: s.other_marketplace_costs,
    non_recoverable_vat: s.non_recoverable_vat,
    contribution_before_open_items: s.contribution_before_open_items,
    contribution_status: s.contribution_status,
    cogs: s.cogs,
    gross_profit_before_open_items: s.gross_profit_before_open_items,
    gross_profit_status: s.gross_profit_status,
    net_available: false,
  }
}

export type PnlSummaryChangeRow = Database["public"]["Functions"]["pnl_summary_change"]["Returns"][number]

export type LedgerMonthData = {
  summary: PnlSummaryRow | null
  /** vs the period before (migration 0061); null only if that RPC has not been applied yet. */
  change: PnlSummaryChangeRow | null
  breakdown: PnlBreakdownRow[]
  /** Kept for the CSV export (services/ledger/export.ts), which reads this exact shape. */
  settlements: PnlSettlementRow[]
  /** One shape for every marketplace's payout (0039/0056); what the Settlements and Reconciliation tabs read. */
  payouts: ExpectedPayoutRow[]
  quality: LedgerQualityRow[]
  waterfall: WaterfallStep[]
}

/** Everything the P&L screen and the export show for one account and period. */
export async function getLedgerMonth(
  businessId: string,
  accountId: string,
  month: LedgerRange
): Promise<LedgerMonthData> {
  const supabase = await createClient()
  const range = { p_from: month.from, p_to: month.to, p_account_id: accountId }

  const [summary, change, breakdown, settlements, payouts, quality] = await Promise.all([
    supabase.rpc("pnl_summary", range),
    supabase.rpc("pnl_summary_change", range),
    supabase.rpc("pnl_breakdown", range),
    supabase.rpc("pnl_settlements", range),
    supabase.rpc("expected_payouts", { ...range, p_business_id: businessId }),
    supabase.rpc("ledger_data_quality", { ...range, p_business_id: businessId }),
  ])

  for (const reply of [summary, breakdown, settlements, payouts, quality]) {
    if (reply.error) throw new Error(`Could not load this period's figures: ${reply.error.message}`)
  }

  const row = summary.data?.[0] ?? null
  let waterfall: WaterfallStep[] = []
  if (row) {
    const steps = await supabase.rpc("dashboard_waterfall_steps", { p_overview: pnlWaterfallInput(row) as Json })
    if (steps.error) throw new Error(`Could not load the profit waterfall: ${steps.error.message}`)
    waterfall = steps.data ?? []
  }

  return {
    summary: row,
    change: change.error ? null : (change.data?.[0] ?? null),
    breakdown: breakdown.data ?? [],
    settlements: settlements.data ?? [],
    payouts: payouts.data ?? [],
    quality: quality.data ?? [],
    waterfall,
  }
}

export type CurrencyMonthData = {
  /** All the business's accounts in the currency, added up in SQL. */
  total: PnlSummaryRow | null
  /** vs the period before (migration 0061); null only if that RPC has not been applied yet. */
  change: PnlSummaryChangeRow | null
  /** The same figures for each of those accounts, for comparison. */
  perAccount: PnlSummaryRow[]
  /** Every account's payouts for the period, one shape for every marketplace (0039/0056). */
  payouts: ExpectedPayoutRow[]
  /** The combined total's waterfall. */
  waterfall: WaterfallStep[]
}

/** One period for every account in one currency. Never across currencies (A12). */
export async function getCurrencyMonth(
  businessId: string,
  currency: string,
  month: LedgerRange
): Promise<CurrencyMonthData> {
  const supabase = await createClient()
  const range = { p_from: month.from, p_to: month.to, p_business_id: businessId }

  const [total, change, perAccount, payouts] = await Promise.all([
    supabase.rpc("pnl_summary", { ...range, p_combine_by_currency: true }),
    supabase.rpc("pnl_summary_change", { ...range, p_combine_by_currency: true }),
    supabase.rpc("pnl_summary", range),
    supabase.rpc("expected_payouts", range),
  ])

  for (const reply of [total, perAccount, payouts]) {
    if (reply.error) throw new Error(`Could not load this period's figures: ${reply.error.message}`)
  }

  const totalRow = (total.data ?? []).find((row) => row.currency === currency) ?? null
  const changeRow = change.error ? null : (change.data ?? []).find((row) => row.currency === currency) ?? null
  let waterfall: WaterfallStep[] = []
  if (totalRow) {
    const steps = await supabase.rpc("dashboard_waterfall_steps", { p_overview: pnlWaterfallInput(totalRow) as Json })
    if (steps.error) throw new Error(`Could not load the profit waterfall: ${steps.error.message}`)
    waterfall = steps.data ?? []
  }

  return {
    total: totalRow,
    change: changeRow,
    perAccount: (perAccount.data ?? []).filter((row) => row.currency === currency),
    payouts: (payouts.data ?? []).filter((row) => row.currency === currency),
    waterfall,
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
