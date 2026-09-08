import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { CircleAlert, Inbox } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { ChannelTable } from "@/features/analytics/components/channel-table"
import { MetricCard } from "@/features/analytics/components/metric-card"
import { RangeSelector } from "@/features/analytics/components/range-selector"
import { getDashboardData } from "@/features/analytics/queries"
import { resolveRange, type RangeValue } from "@/features/analytics/types"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { formatMoney, formatNumber, formatPercent, percentChange } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"

export const metadata: Metadata = {
  title: "Dashboard",
}

export default async function DashboardPage(props: PageProps<"/dashboard">) {
  const searchParams = await props.searchParams
  const rangeParam = Array.isArray(searchParams.range)
    ? searchParams.range[0]
    : searchParams.range
  const range = resolveRange(rangeParam)

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) {
    redirect(ONBOARDING_ROUTE)
  }

  const supabase = await createClient()
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user!.id)
    .maybeSingle()

  const data = await getDashboardData(activeBusiness.id, range.days)
  const { current, previous, channels } = data
  const currency = activeBusiness.currency

  const hasSales = current.order_count > 0

  // How much of the margin is actually backed by recorded costs. Lines with no
  // cost contribute nothing to COGS, which inflates profit — so if any are
  // missing, every margin figure below carries a warning rather than being
  // presented as fact.
  const costCoverage =
    current.items_total > 0
      ? Math.round((current.items_with_cost / current.items_total) * 100)
      : 100
  const costGap = current.items_total - current.items_with_cost
  const marginWarning =
    costGap > 0
      ? `${costGap} of ${current.items_total} items have no cost recorded, so profit is overstated.`
      : undefined

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
              {range.label.toLowerCase().replace("last ", "The last ")} · all figures in{" "}
              {currency}
            </p>
          </div>
          <RangeSelector active={range.value as RangeValue} />
        </div>

        {/* A failed calculation must never be shown as zero. An owner acting on
            a fabricated zero is worse off than one who knows a figure is
            unavailable. */}
        {data.error && (
          <div
            role="alert"
            className="mt-6 flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-subtle px-4 py-3 text-sm text-danger-strong"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">These figures could not be calculated.</p>
              <p className="mt-0.5 text-xs opacity-90">
                Nothing below is reliable. Technical detail: {data.error}
              </p>
            </div>
          </div>
        )}

        {!data.error && !hasSales ? (
          <Card className="mt-6 shadow-none">
            <CardContent className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <span className="flex size-11 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <Inbox className="size-5" aria-hidden />
              </span>
              <p className="font-heading text-lg font-semibold">No sales in this period</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Once orders exist, this page will show revenue, true margin after
                fees, and which channel actually earns you the most. Connecting a
                sales channel or importing a spreadsheet comes in a later phase.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <section className="mt-6" aria-label="Headline figures">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  emphasis
                  label="Revenue"
                  value={formatMoney(current.revenue, currency)}
                  change={percentChange(current.revenue, previous.revenue)}
                  explanation="Total of all orders placed in this period, excluding cancelled orders."
                />
                <MetricCard
                  emphasis
                  label="Gross profit"
                  value={formatMoney(current.gross_profit, currency)}
                  change={percentChange(current.gross_profit, previous.gross_profit)}
                  explanation="Revenue minus the cost of the goods sold and minus channel fees."
                  warning={marginWarning}
                />
                <MetricCard
                  label="Gross margin"
                  value={formatPercent(current.gross_margin)}
                  change={percentChange(current.gross_margin, previous.gross_margin)}
                  explanation="Gross profit as a share of revenue."
                  warning={marginWarning}
                />
                <MetricCard
                  label="Net profit"
                  value={formatMoney(current.net_profit, currency)}
                  change={percentChange(current.net_profit, previous.net_profit)}
                  explanation="Gross profit minus operating expenses recorded in this period."
                  warning={marginWarning}
                />
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  label="Orders"
                  value={formatNumber(current.order_count)}
                  change={percentChange(current.order_count, previous.order_count)}
                  explanation="Orders placed in this period, excluding cancelled ones."
                />
                <MetricCard
                  label="Average order value"
                  value={formatMoney(current.avg_order_value, currency)}
                  change={percentChange(current.avg_order_value, previous.avg_order_value)}
                  explanation="Revenue divided by the number of orders."
                />
                <MetricCard
                  label="Channel fees"
                  value={formatMoney(current.fees, currency)}
                  change={percentChange(current.fees, previous.fees)}
                  higherIsBetter={false}
                  explanation="Marketplace commission, payment processing and fulfilment charged on these orders."
                />
                <MetricCard
                  label="Expenses"
                  value={formatMoney(current.expenses, currency)}
                  change={percentChange(current.expenses, previous.expenses)}
                  higherIsBetter={false}
                  explanation="Operating costs recorded against this period."
                />
              </div>
            </section>

            <section className="mt-8" aria-label="Channel performance">
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

            <section className="mt-4 grid gap-4 sm:grid-cols-3" aria-label="Secondary figures">
              <MetricCard
                label="Units sold"
                value={formatNumber(current.units_sold, 2)}
                change={percentChange(current.units_sold, previous.units_sold)}
                explanation="Total quantity across all order lines in this period."
              />
              <MetricCard
                label="Customers who ordered"
                value={formatNumber(current.customer_count)}
                change={percentChange(current.customer_count, previous.customer_count)}
                explanation="Distinct customers with at least one order. Orders with no customer attached are not counted."
              />
              <MetricCard
                label="Refunds"
                value={formatMoney(current.refunds, currency)}
                change={percentChange(current.refunds, previous.refunds)}
                higherIsBetter={false}
                explanation="Value of returns approved, received or refunded in this period."
              />
            </section>

            <p className="mt-6 text-xs text-muted-foreground">
              Every figure here is calculated in the database from your own
              records. Nothing is estimated or generated.
              {costCoverage < 100 &&
                ` Cost data covers ${costCoverage}% of order lines in this period.`}
            </p>
          </>
        )}
      </div>
    </AppShell>
  )
}
