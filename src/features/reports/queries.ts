import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { LedgerMonth } from "@/services/ledger/period"
import {
  reportAbout,
  reportSheets,
  REPORT_CATALOG,
  type Report,
  type ReportData,
  type ReportKey,
} from "@/services/reports/catalog"

/**
 * Loads one report through the signed-in user's session (RLS), for the
 * business the session chose. Every figure comes from the SQL readers.
 */
export async function loadReport(
  business: { id: string; name: string },
  key: ReportKey,
  month: LedgerMonth | null
): Promise<Report> {
  const supabase = await createClient()
  const range = month ? { p_from: month.from, p_to: month.to } : null
  const fail = (what: string, message: string) => {
    throw new Error(`Could not load ${what}: ${message}`)
  }

  const data: ReportData = {}
  switch (key) {
    case "marketplace-profit": {
      if (!range) throw new Error("Choose a month.")
      const [perAccount, perCurrency] = await Promise.all([
        supabase.rpc("pnl_summary", { ...range, p_business_id: business.id }),
        supabase.rpc("pnl_summary", { ...range, p_business_id: business.id, p_combine_by_currency: true }),
      ])
      if (perAccount.error) fail("marketplace profit", perAccount.error.message)
      if (perCurrency.error) fail("marketplace profit", perCurrency.error.message)
      data.perAccount = perAccount.data ?? []
      data.perCurrency = perCurrency.data ?? []
      break
    }
    case "product-profit": {
      if (!range) throw new Error("Choose a month.")
      const { data: rows, error } = await supabase.rpc("pnl_by_product", { ...range, p_business_id: business.id })
      if (error) fail("product profit", error.message)
      data.products = rows ?? []
      break
    }
    case "net-profit": {
      if (!range) throw new Error("Choose a month.")
      const [net, expenses] = await Promise.all([
        supabase.rpc("pnl_net_profit", { ...range, p_business_id: business.id }),
        supabase.rpc("expense_breakdown", { ...range, p_business_id: business.id }),
      ])
      if (net.error) fail("net profit", net.error.message)
      if (expenses.error) fail("expenses", expenses.error.message)
      data.net = net.data ?? []
      data.expenses = expenses.data ?? []
      break
    }
    case "payouts": {
      const [payouts, cashflow] = await Promise.all([
        supabase.rpc("expected_payouts", {
          p_business_id: business.id,
          p_from: range?.p_from ?? null,
          p_to: range?.p_to ?? null,
        }),
        supabase.rpc("expected_cashflow", { p_business_id: business.id }),
      ])
      if (payouts.error) fail("expected payouts", payouts.error.message)
      if (cashflow.error) fail("expected cashflow", cashflow.error.message)
      data.payouts = payouts.data ?? []
      data.cashflow = cashflow.data ?? []
      break
    }
    case "data-quality": {
      const { data: rows, error } = await supabase.rpc("ledger_data_quality", { p_business_id: business.id })
      if (error) fail("data quality", error.message)
      data.quality = rows ?? []
      break
    }
  }
  const sheets = reportSheets(key, data)

  return {
    key,
    title: REPORT_CATALOG[key].title,
    about: reportAbout(key, business.name, month?.key ?? null, month?.label ?? null),
    sheets,
  }
}
