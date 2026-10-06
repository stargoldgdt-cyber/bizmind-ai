import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { Download } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { ProductProfitBody } from "@/features/catalog/components/product-profit/product-profit-body"
import { getProductProfit, listActiveProducts, type ProductProfitRow } from "@/features/catalog/queries"
import { LedgerFilters } from "@/features/ledger/components/ledger-filters"
import { firstParam, ledgerHref } from "@/features/ledger/params"
import {
  getCurrencyMonth,
  getLedgerMonth,
  getLedgerPeriods,
  listLedgerAccounts,
  type LedgerAccount,
} from "@/features/ledger/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { buildProfitRows } from "@/services/catalog/product-profit-view"
import type { PnlSummaryRow } from "@/services/ledger/export"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"

export const metadata: Metadata = {
  title: "Product profitability",
}

/**
 * Product profitability (GCC Phase 6; redesigned 2026-10-05).
 *
 * PERFORMS NO CALCULATIONS: pnl_by_product() works out every row in SQL.
 * Grouping, ranking and the sentences come from
 * services/catalog/product-profit-view.ts, which only compares and counts.
 * A product's figures include only the lines the marketplace attributed to
 * one of its order lines. Marketplace-level fees and advertising are never
 * spread across products (A7); they stay in their own row, so all rows
 * together equal the account's contribution less COGS.
 */

const ALL_PREFIX = "all-"

export default async function ProductProfitPage(props: PageProps<"/ledger/products">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, accounts, periods, products] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listLedgerAccounts(activeBusiness.id),
    getLedgerPeriods(activeBusiness.id),
    listActiveProducts(activeBusiness.id),
  ])

  const byCurrency = new Map<string, LedgerAccount[]>()
  for (const a of accounts) byCurrency.set(a.currency, [...(byCurrency.get(a.currency) ?? []), a])
  const currencyGroups = [...byCurrency.entries()].filter(([, list]) => list.length > 1)

  const requested = firstParam(searchParams.account)
  const requestedCurrency = requested?.startsWith(ALL_PREFIX) ? requested.slice(ALL_PREFIX.length) : null
  const combined = currencyGroups.find(([currency]) => currency === requestedCurrency)?.[0] ?? null
  const account = combined
    ? null
    : (accounts.find((a) => a.id === requested) ??
      accounts.find((a) => periods.some((p) => p.marketplace_account_id === a.id)) ??
      accounts[0] ??
      null)

  const inScope = new Set(
    combined ? (byCurrency.get(combined) ?? []).map((a) => a.id) : account ? [account.id] : []
  )
  const monthKeys = [...new Set(periods.filter((p) => inScope.has(p.marketplace_account_id)).map((p) => monthKeyOf(p.month)))]
    .sort()
    .reverse()
  const monthOptions = monthKeys.map((key) => parseLedgerMonth(key)).filter((m): m is LedgerMonth => m !== null)
  const month = parseLedgerMonth(firstParam(searchParams.month)) ?? monthOptions[0] ?? null
  if (month && !monthOptions.some((m) => m.key === month.key)) monthOptions.unshift(month)

  let rows: ProductProfitRow[] = []
  let summary: PnlSummaryRow | null = null
  if (month && combined) {
    const [profit, group] = await Promise.all([
      getProductProfit(activeBusiness.id, { currency: combined }, month),
      getCurrencyMonth(activeBusiness.id, combined, month),
    ])
    rows = profit
    summary = group.total
  } else if (month && account) {
    const [profit, single] = await Promise.all([
      getProductProfit(activeBusiness.id, { accountId: account.id }, month),
      getLedgerMonth(activeBusiness.id, account.id, month),
    ])
    rows = profit
    summary = single.summary
  }

  const filterOptions = [
    ...accounts.map((a) => ({ id: a.id, label: a.label, detail: `${a.marketplace_code} · ${a.currency}` })),
    ...currencyGroups.map(([currency, list]) => ({
      id: `${ALL_PREFIX}${currency}`,
      label: `All ${currency} accounts`,
      detail: `${list.length} accounts, added up`,
    })),
  ]
  const currency = summary?.currency ?? combined ?? account?.currency ?? ""

  const items = buildProfitRows(rows, new Map(products.map((p) => [p.id, p.sku_code])))
  const notAllocated = rows.find((row) => row.row_kind === "NOT_ALLOCATED") ?? null

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-[90rem] grid-cols-[minmax(0,1fr)] gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-3xl font-bold tracking-tight">Product profitability</h1>
            <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
              See which products make money, which ones lose money, and what to do next.
            </p>
          </div>
          {accounts.length > 0 && (
            <div className="flex flex-wrap items-end gap-3">
              <LedgerFilters
                basePath="/ledger/products"
                accounts={filterOptions}
                months={monthOptions.map((m) => ({ key: m.key, label: m.label }))}
                accountId={combined ? `${ALL_PREFIX}${combined}` : (account?.id ?? "")}
                monthKey={month?.key ?? null}
              />
              <Button asChild className="h-9 gap-2 rounded-4xl">
                <a href={ledgerHref("/api/v1/reports/product-profit", { month: month?.key })}>
                  <Download className="size-4" aria-hidden />
                  Export
                </a>
              </Button>
            </div>
          )}
        </header>

        {accounts.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Add a marketplace account and upload its reports first.
          </p>
        ) : !month || items.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            No profit lines for this choice.
          </p>
        ) : (
          <ProductProfitBody
            items={items}
            currency={currency}
            monthLabel={month.label}
            notAllocatedContribution={notAllocated?.contribution ?? null}
            totals={
              summary
                ? {
                    netSales: summary.net_sales,
                    contribution: summary.contribution,
                    contributionBefore: summary.contribution_before_open_items,
                    cogs: summary.cogs,
                    grossProfit: summary.gross_profit,
                    grossProfitBefore: summary.gross_profit_before_open_items,
                  }
                : null
            }
          />
        )}
      </div>
    </AppShell>
  )
}
