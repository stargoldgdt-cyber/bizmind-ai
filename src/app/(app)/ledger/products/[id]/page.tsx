import type { Metadata } from "next"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { ArrowLeft, BadgePercent, Boxes, ChartColumn, ClipboardList, Coins, PieChart, Scale, Store, TrendingUp } from "lucide-react"
import { z } from "zod"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { InsightsPanel } from "@/features/catalog/components/product-analysis/insights-panel"
import { MarketplaceTable } from "@/features/catalog/components/product-analysis/marketplace-table"
import { OrdersTable } from "@/features/catalog/components/product-analysis/orders-table"
import { PriceCheck } from "@/features/catalog/components/product-analysis/price-check"
import { ProductTrendChart } from "@/features/catalog/components/product-analysis/trend-chart"
import { StatusPill } from "@/features/catalog/components/product-profit/status-pill"
import { getProductAnalysis, getProductDetail } from "@/features/catalog/queries"
import { LedgerFilters } from "@/features/ledger/components/ledger-filters"
import { firstParam, ledgerHref } from "@/features/ledger/params"
import { getLedgerPeriods, listLedgerAccounts } from "@/features/ledger/queries"
import { resolveLedgerScope } from "@/features/ledger/scope"
import { CostDonutChart } from "@/features/overview/components/cost-donut-chart"
import { KpiCard } from "@/features/overview/components/kpi-card"
import { Card, MarketplaceBadge } from "@/features/overview/components/sections"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { TARGET_MARGINS, parseTargetMargin } from "@/services/catalog/product-analysis"
import { buildInsights } from "@/services/catalog/product-analysis-view"
import { statusOfFigures } from "@/services/catalog/product-profit-view"
import { previousLedgerMonth } from "@/services/ledger/period"

export const metadata: Metadata = {
  title: "Product analysis",
}

/**
 * One product, analysed (reached from "Review product" / "Review price" on
 * Product profitability).
 *
 * PERFORMS NO CALCULATIONS: product_analysis() works out every figure, change,
 * share and chart position in SQL, from the same lines as the table's row, so
 * this page and the table cannot disagree. The insights are fixed rules over
 * those figures (services/catalog/product-analysis-view.ts). What the data does
 * not hold is not shown: no stock, no photo, no dimensions, no AI-written
 * advice, and no advertising (marketplaces report it without a SKU).
 */

const NAME: Record<string, string> = { AMAZON: "Amazon", NOON: "noon", CARREFOUR: "Carrefour" }

export default async function ProductAnalysisPage(props: PageProps<"/ledger/products/[id]">) {
  const { id } = await props.params
  if (!z.string().uuid().safeParse(id).success) notFound()
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])
  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, detail, accounts, periods] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getProductDetail(activeBusiness.id, id),
    listLedgerAccounts(activeBusiness.id),
    getLedgerPeriods(activeBusiness.id),
  ])
  if (!detail) notFound()
  const { product } = detail
  const canManage = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"

  const { account, month, monthOptions, filterOptions, selectedAccount, currency } = resolveLedgerScope(accounts, periods, searchParams)
  const targetMargin = parseTargetMargin(firstParam(searchParams.target))

  const analysis =
    month && currency
      ? await getProductAnalysis(activeBusiness.id, id, { currency, accountId: account?.id ?? null }, month, targetMargin)
      : null
  const current = analysis?.current ?? null
  const previousLabel = month ? previousLedgerMonth(month).label : ""

  const status = current
    ? statusOfFigures({
        cogsStatus: current.cogs_status,
        margin: current.margin,
        grossProfit: current.gross_profit,
        netSales: current.net_sales,
      })
    : null
  const insights = analysis && status ? buildInsights(analysis, status) : null

  const backHref = ledgerHref("/ledger/products", { account: selectedAccount, month: month?.key })
  const editHref = `/catalog/products/${id}`
  const targetHrefs = Object.fromEntries(
    TARGET_MARGINS.map((target) => [
      target,
      ledgerHref(`/ledger/products/${id}`, { account: selectedAccount, month: month?.key, target }),
    ])
  )
  const marketplaces = analysis ? [...new Set(analysis.marketplaces.map((m) => m.marketplace_code))] : []

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-[90rem] grid-cols-[minmax(0,1fr)] gap-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link href={backHref} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-3.5" aria-hidden />
              Product profitability
            </Link>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="font-heading text-3xl font-bold tracking-tight">{product.name}</h1>
              {status && <StatusPill status={status} />}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {[product.sku_code ? `SKU ${product.sku_code}` : null, product.category, product.brand].filter(Boolean).join(" · ") ||
                "No SKU code, category or brand"}
              {product.status === "ARCHIVED" && " · Archived"}
            </p>
            {marketplaces.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {marketplaces.map((code) => (
                  <li key={code} className="inline-flex items-center gap-2 rounded-full border border-border bg-card py-1 pr-3 pl-1 text-xs font-medium">
                    <MarketplaceBadge code={code} />
                    {NAME[code] ?? code}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {accounts.length > 0 && (
              <LedgerFilters
                basePath={`/ledger/products/${id}`}
                accounts={filterOptions}
                months={monthOptions.map((m) => ({ key: m.key, label: m.label }))}
                accountId={selectedAccount}
                monthKey={month?.key ?? null}
              />
            )}
            <Button asChild variant="outline" className="h-9 rounded-4xl">
              <Link href={editHref}>Product and costs</Link>
            </Button>
          </div>
        </header>

        {!analysis || !month ? (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Add a marketplace account and upload its reports first.
          </p>
        ) : !current ? (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            No sales of this product in {month.label} for this choice. Pick another month or marketplace above.
          </p>
        ) : (
          <>
            <section aria-label="This month's figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                label="Net sales"
                icon={Coins}
                value={formatMoney(current.net_sales, analysis.currency)}
                change={analysis.changes?.net_sales_pct ?? null}
                changeLabel={`vs ${previousLabel}`}
              />
              <KpiCard
                label="Units sold"
                icon={Boxes}
                value={formatNumber(current.units, 4)}
                change={analysis.changes?.units_pct ?? null}
                changeLabel={`vs ${previousLabel}`}
              />
              <KpiCard
                label="Gross profit"
                icon={TrendingUp}
                value={current.gross_profit === null ? "Incomplete" : formatMoney(current.gross_profit, analysis.currency)}
                change={current.gross_profit === null ? undefined : (analysis.changes?.gross_profit_pct ?? null)}
                changeLabel={`vs ${previousLabel}`}
                note={current.gross_profit === null ? "Needs the product's cost for every unit sold." : undefined}
              />
              <KpiCard
                label="Gross margin"
                icon={BadgePercent}
                value={current.margin === null ? "—" : formatPercent(current.margin)}
                note={
                  analysis.changes?.margin_points != null
                    ? `${analysis.changes.margin_points === 0 ? "No change" : `${formatNumber(Math.abs(analysis.changes.margin_points), 1)} points ${analysis.changes.margin_points > 0 ? "higher" : "lower"}`} than ${previousLabel}`
                    : `No comparison with ${previousLabel}`
                }
              />
            </section>

            <div className="grid gap-4 lg:grid-cols-5">
              <Card
                className="lg:col-span-3"
                icon={ChartColumn}
                title="Sales, profit and margin trend"
                description="Net sales and gross profit for the last 12 months."
              >
                <ProductTrendChart months={analysis.months} currency={analysis.currency} />
              </Card>
              <div className="lg:col-span-2">
                {insights && <InsightsPanel insights={insights} editHref={editHref} canManage={canManage} />}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-5">
              <Card className="lg:col-span-3" icon={Store} title="Marketplace comparison" description={`${month.label}, by marketplace.`}>
                <MarketplaceTable rows={analysis.marketplaces} total={current} currency={analysis.currency} />
              </Card>
              <Card
                className="lg:col-span-2"
                icon={PieChart}
                title="Cost breakdown"
                description={`${month.label}: where this product's marketplace costs go.`}
              >
                <CostDonutChart rows={analysis.costs} total={analysis.costs_total} currency={analysis.currency} />
                <dl className="grid grid-cols-3 gap-3 border-t border-border px-5 py-4 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Product cost</dt>
                    <dd className="mt-0.5 font-mono font-semibold tabular-nums">{current.cogs_pct === null ? "Incomplete" : formatPercent(current.cogs_pct)}</dd>
                    <dd className="text-xs text-muted-foreground">of net sales</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Marketplace costs</dt>
                    <dd className="mt-0.5 font-mono font-semibold tabular-nums">{current.costs_pct === null ? "—" : formatPercent(current.costs_pct)}</dd>
                    <dd className="text-xs text-muted-foreground">of net sales</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Gross margin</dt>
                    <dd className="mt-0.5 font-mono font-semibold tabular-nums">{current.margin === null ? "—" : formatPercent(current.margin)}</dd>
                    <dd className="text-xs text-muted-foreground">what is left</dd>
                  </div>
                </dl>
                <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
                  Advertising is not included: marketplaces report it without a product, so it is never spread across products.
                </p>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-5">
              <Card className="lg:col-span-2" icon={Scale} title="Price and margin check" description={`${month.label} figures.`}>
                <PriceCheck price={analysis.price} currency={analysis.currency} hrefs={targetHrefs} />
              </Card>
              <Card className="lg:col-span-3" icon={ClipboardList} title="Recent orders" description={`The latest orders of this product in ${month.label}.`}>
                <OrdersTable rows={analysis.orders} currency={analysis.currency} />
              </Card>
            </div>
          </>
        )}

      </div>
    </AppShell>
  )
}
