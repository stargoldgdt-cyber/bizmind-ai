import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { CircleAlert } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { ChannelTable } from "@/features/analytics/components/channel-table"
import { DataQuality } from "@/features/analytics/components/data-quality"
import { EmptyDashboard } from "@/features/analytics/components/empty-dashboard"
import { HealthCard } from "@/features/analytics/components/health-card"
import { InsightList } from "@/features/analytics/components/insight-list"
import { MetricCard } from "@/features/analytics/components/metric-card"
import { PeriodNarrative } from "@/features/analytics/components/period-narrative"
import { ProductTable } from "@/features/analytics/components/product-table"
import { RangeSelector } from "@/features/analytics/components/range-selector"
import { periodFromParams } from "@/features/analytics/page-context"
import { businessHasAnyOrders } from "@/features/analytics/queries"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { listAlerts, presentAlert } from "@/services/automation"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import {
  findComparison,
  getAnalytics,
  METRICS,
  type MetricComparison,
} from "@/services/analytics"
import { createClient, getCurrentUser } from "@/lib/supabase/server"

export const metadata: Metadata = {
  title: "Dashboard",
}

/**
 * The dashboard.
 *
 * Performs NO calculations. Every figure, including every period-over-period
 * change, arrives already computed from the analytics service. This page
 * chooses what to show and how to phrase it — nothing more.
 */
export default async function DashboardPage(props: PageProps<"/dashboard">) {
  const searchParams = await props.searchParams
  // Shared resolver, so a custom range works identically on every page and no
  // date arithmetic happens in a component.
  const period = periodFromParams(searchParams)

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user!.id)
    .maybeSingle()

  // The business comes from the session, never from the request.
  // Fetched alongside the analytics, not after it: the empty state needs to
  // know whether this business has EVER recorded an order, so it can tell a
  // new owner apart from an established one having a quiet fortnight.
  const [analytics, hasAnyData, openAlerts] = await Promise.all([
    getAnalytics(activeBusiness.id, period, activeBusiness.currency),
    businessHasAnyOrders(activeBusiness.id),
    // Alerts are not period-scoped: something that needs attention needs it
    // regardless of which window the owner happens to be looking at.
    listAlerts(activeBusiness.id, { status: "OPEN", limit: 3 }),
  ])

  const { current, comparisons, channels, products, health, insights, reconciliation } = analytics
  const currency = activeBusiness.currency

  const hasSales = current.orders_count > 0
  const coverage = current.cost_coverage === null ? null : Number(current.cost_coverage)
  const missingCostLines = current.items_total - current.items_with_cost
  const feeCoverage = current.fee_coverage === null ? null : Number(current.fee_coverage)

  // Two independent gaps can overstate profit: unrecorded costs and
  // unrecorded fees. Both are named, because "some data is missing" tells an
  // owner nothing about what to fix.
  const gaps: string[] = []
  if (missingCostLines > 0) {
    gaps.push(`${missingCostLines} of ${current.items_total} order lines have no recorded cost`)
  }
  if (current.orders_fees_unknown > 0) {
    gaps.push(`${current.orders_fees_unknown} of ${current.orders_count} orders have no recorded fee`)
  }
  const marginWarning =
    gaps.length > 0 ? `${gaps.join("; ")} — so this is overstated.` : undefined

  /** Pulls a precomputed comparison. The page never derives one. */
  const change = (metric: string): MetricComparison | undefined =>
    findComparison(comparisons, metric)

  const pct = (metric: string): number | null => {
    const value = change(metric)?.percent_change
    return value === null || value === undefined ? null : Number(value)
  }

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{activeBusiness.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {period.label} · {period.comparisonLabel} · all figures in {currency}
            </p>
          </div>
          <RangeSelector
            active={period.key}
            customLabel={period.key === "custom" ? period.label : undefined}
          />
        </div>

        {period.incomplete && hasSales && (
          <p className="mt-3 text-xs text-muted-foreground">
            This period is still in progress, so it is being compared against a
            complete one. Expect the comparison to look weaker than it is.
          </p>
        )}

        {analytics.error && (
          <div
            role="alert"
            className="mt-6 flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-subtle px-4 py-3 text-sm text-danger-strong"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">These figures could not be calculated.</p>
              <p className="mt-0.5 text-xs opacity-90">
                Nothing below is reliable. Technical detail: {analytics.error}
              </p>
            </div>
          </div>
        )}

        {!analytics.error && !hasSales ? (
          <EmptyDashboard hasAnyData={hasAnyData} periodLabel={period.label} />
        ) : (
          <>
            {/*
              Above every figure, because "something needs your attention" is a
              different kind of statement from "here is your revenue" and
              should not have to be scrolled to.
            */}
            {openAlerts.length > 0 && (
              <section className="mt-6" aria-label="Needs attention">
                <div className="overflow-hidden rounded-xl border border-warning/30 bg-warning-subtle">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                    <p className="text-sm font-medium text-warning-strong">
                      {openAlerts.length === 1
                        ? "One thing needs your attention"
                        : `${openAlerts.length} things need your attention`}
                    </p>
                    <Button asChild size="sm" variant="outline" className="rounded-4xl">
                      <Link href="/alerts">Open alerts</Link>
                    </Button>
                  </div>

                  <ul className="border-t border-warning/25">
                    {openAlerts.map((alert) => {
                      const shown = presentAlert(alert, currency)
                      return (
                        <li
                          key={alert.id}
                          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-warning/20 px-5 py-2.5 last:border-0"
                        >
                          <span className="text-sm">{alert.title}</span>
                          <span className="font-mono text-xs tabular-nums text-warning-strong">
                            {shown.metricLabel} {shown.value} · limit {shown.threshold}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </section>
            )}

            <section className="mt-6" aria-label="Headline figures">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  emphasis
                  label={METRICS.revenue.label}
                  value={formatMoney(current.revenue, currency)}
                  change={pct("revenue")}
                  explanation={METRICS.revenue.definition}
                />
                <MetricCard
                  emphasis
                  label={METRICS.gross_profit.label}
                  value={formatMoney(current.gross_profit, currency)}
                  change={pct("gross_profit")}
                  explanation={METRICS.gross_profit.definition}
                  warning={marginWarning}
                />
                <MetricCard
                  label={METRICS.gross_margin.label}
                  value={formatPercent(current.gross_margin)}
                  change={pct("gross_margin")}
                  explanation={METRICS.gross_margin.definition}
                  warning={marginWarning}
                />
                <MetricCard
                  label={METRICS.net_profit.label}
                  value={formatMoney(current.net_profit, currency)}
                  change={pct("net_profit")}
                  explanation={METRICS.net_profit.definition}
                  warning={marginWarning}
                />
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  label={METRICS.orders_count.label}
                  value={formatNumber(current.orders_count)}
                  change={pct("orders_count")}
                  explanation={METRICS.orders_count.definition}
                />
                <MetricCard
                  label={METRICS.avg_order_value.label}
                  value={formatMoney(current.avg_order_value, currency)}
                  change={pct("avg_order_value")}
                  explanation={METRICS.avg_order_value.definition}
                />
                <MetricCard
                  label={METRICS.fees.label}
                  value={formatMoney(current.fees, currency)}
                  change={pct("fees")}
                  higherIsBetter={METRICS.fees.higherIsBetter}
                  explanation={METRICS.fees.definition}
                  warning={
                    current.orders_fees_unknown > 0
                      ? `${current.orders_fees_unknown} orders have no fee recorded — treated as unknown, not zero.`
                      : undefined
                  }
                />
                <MetricCard
                  label={METRICS.expenses.label}
                  value={formatMoney(current.expenses, currency)}
                  change={pct("expenses")}
                  higherIsBetter={METRICS.expenses.higherIsBetter}
                  explanation={METRICS.expenses.definition}
                />
              </div>
            </section>

            <section className="mt-8" aria-label="What this means">
              <PeriodNarrative key={period.key} range={period.key} />
            </section>

            {/*
              Placed directly under the narrative, before the deeper tables.
              An owner should learn how much of this they can rely on before
              they start drawing conclusions from it, not after.
            */}
            <section className="mt-4" aria-label="Data quality">
              <DataQuality current={current} />
            </section>

            <section className="mt-4" aria-label="Findings">
              <InsightList insights={insights} currency={currency} />
            </section>

            <section className="mt-4" aria-label="Business health">
              <HealthCard health={health} currency={currency} />
            </section>

            <section className="mt-4" aria-label="Channel performance">
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle>Channel performance</CardTitle>
                  <CardDescription>
                    Revenue is not profit. Fees are counted per channel, so the
                    margin column shows what each one actually earns you.
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  <ChannelTable channels={channels} currency={currency} />
                </CardContent>
              </Card>
            </section>

            <section className="mt-4" aria-label="Product performance">
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle>Product performance</CardTitle>
                  <CardDescription>
                    Revenue here is order-line revenue, so it excludes shipping and
                    order-level discounts. Fees are shared across lines in
                    proportion to their value — an allocation, not a charge you
                    actually paid per product.
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  <ProductTable products={products} currency={currency} />
                </CardContent>
              </Card>
            </section>

            <section className="mt-4 grid gap-4 sm:grid-cols-3" aria-label="Secondary figures">
              <MetricCard
                label={METRICS.units_sold.label}
                value={formatNumber(current.units_sold, 2)}
                change={pct("units_sold")}
                explanation={METRICS.units_sold.definition}
              />
              <MetricCard
                label={METRICS.customers_count.label}
                value={formatNumber(current.customers_count)}
                change={pct("customers_count")}
                explanation={METRICS.customers_count.definition}
              />
              <MetricCard
                label={METRICS.refunds.label}
                value={formatMoney(current.refunds, currency)}
                change={pct("refunds")}
                higherIsBetter={METRICS.refunds.higherIsBetter}
                explanation={METRICS.refunds.definition}
              />
            </section>

            <div className="mt-6 space-y-1 text-xs text-muted-foreground">
              <p>
                Every figure here is calculated in the database from your own
                records. Nothing is estimated or generated.
                {coverage !== null && coverage < 100 &&
                  ` Cost data covers ${coverage}% of order lines.`}
                {feeCoverage !== null && feeCoverage < 100 &&
                  ` Fee data covers ${feeCoverage}% of orders.`}
              </p>
              {Number(reconciliation.channel_difference) !== 0 && (
                <p className="text-danger-strong">
                  Channel revenue does not reconcile with total revenue — a
                  difference of {formatMoney(reconciliation.channel_difference, currency)}.
                  Please report this.
                </p>
              )}
              {Number(reconciliation.order_line_gap) !== 0 && (
                <p>
                  Order revenue exceeds product-line revenue by{" "}
                  {formatMoney(reconciliation.order_line_gap, currency)} — shipping,
                  order-level discounts, and any orders with no product lines.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
