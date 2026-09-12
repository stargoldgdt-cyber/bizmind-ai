import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { CircleAlert } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { ChannelFilter } from "@/features/analytics/components/channel-filter"
import { ChannelIntelligence } from "@/features/analytics/components/channel-intelligence"
import { ChannelScatter } from "@/features/analytics/components/channel-scatter"
import { EmptyDashboard } from "@/features/analytics/components/empty-dashboard"
import { HealthCard } from "@/features/analytics/components/health-card"
import { InsightList } from "@/features/analytics/components/insight-list"
import { MetricCard } from "@/features/analytics/components/metric-card"
import { BusinessBrief } from "@/features/analytics/components/business-brief"
import { ProductIntelligence } from "@/features/analytics/components/product-intelligence"
import { QualityPanel } from "@/features/analytics/components/quality-panel"
import { RangeSelector } from "@/features/analytics/components/range-selector"
import { SyncStatus } from "@/features/analytics/components/sync-status"
import { WhatChanged } from "@/features/analytics/components/what-changed"
import {
  channelFromParams,
  channelParamFor,
  filterHref,
  NO_CHANNEL,
  scopeFor,
} from "@/features/analytics/dashboard-params"
import { param, periodFromParams } from "@/features/analytics/page-context"
import { businessHasAnyOrders, listChannels } from "@/features/analytics/queries"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import {
  findComparison,
  getAnalytics,
  getChangeDrivers,
  getChannelComparison,
  getDataQuality,
  METRICS,
  type AnalyticsScope,
  type MetricComparison,
  type ResolvedPeriod,
} from "@/services/analytics"
import { listAlerts, presentAlert } from "@/services/automation"

export const metadata: Metadata = {
  title: "Dashboard",
}

/**
 * The decision workspace.
 *
 * PERFORMS NO CALCULATIONS. Every figure, every share, every change and every
 * coverage arrives already computed by the analytics service. This page
 * chooses what to show, in what order, and how to phrase it.
 *
 * THE ORDER IS THE ARGUMENT
 * -------------------------
 *   what needs attention · how healthy · the headline figures · what changed
 *   · which channel earns · which product earns · what is missing · what it
 *   means
 *
 * Health before the figures, because how far to trust them changes how to
 * read them. What changed before the breakdowns, because the breakdowns are
 * where an owner goes to answer it.
 *
 * THE FILTERS ARE THE WHOLE PAGE
 * ------------------------------
 * Date and channel live in the URL and are passed to the analytics service, so
 * selecting Amazon re-computes revenue, cost, fees, margin, products and the
 * trend for Amazon -- in the database. Nothing is filtered in the browser.
 *
 * The deeper sections stream in: the page does not wait for product detail to
 * show revenue, and the AI brief never blocks anything.
 */
export default async function DashboardPage(props: PageProps<"/dashboard">) {
  const searchParams = await props.searchParams
  const period = periodFromParams(searchParams)
  const channelChoice = channelFromParams(searchParams)
  const scope = scopeFor(channelChoice)

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
  const [analytics, hasAnyData, openAlerts, channels] = await Promise.all([
    getAnalytics(activeBusiness.id, period, activeBusiness.currency, { scope }),
    businessHasAnyOrders(activeBusiness.id),
    // Not period-scoped: something that needs attention needs it regardless of
    // the window the owner happens to be looking at.
    listAlerts(activeBusiness.id, { status: "OPEN", limit: 3 }),
    listChannels(activeBusiness.id),
  ])

  const { current, comparisons, products, health, insights, businessWide } = analytics
  const currency = activeBusiness.currency

  const hasSales = current.orders_count > 0
  const scoped = current.channel_scoped
  const activeChannelId = channelChoice.kind === "channel" ? channelChoice.channelId : null
  const activeChannelName =
    channelChoice.kind === "unattributed"
      ? "orders with no channel"
      : (channels.find((c) => c.id === activeChannelId)?.name ?? null)

  // What the brief is told to describe: the page's own filters, as strings, so
  // the server action re-reads them with the same functions this page used.
  const briefFilters: Record<string, string> = {}
  for (const key of ["range", "from", "to", "channel"] as const) {
    const value = param(searchParams, key)
    if (value) briefFilters[key] = value
  }
  const briefKey = JSON.stringify(briefFilters)

  const hrefForChannel = (channel: string | null) =>
    filterHref("/dashboard", searchParams, { channel })
  const hrefForIssue = (issue: string) =>
    filterHref("/data-quality", searchParams, { issue })

  const missingCostLines = current.items_total - current.items_with_cost
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
        {/* ---- Header: what, when, which channel, how current ------------- */}
        <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">
              {activeBusiness.name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {period.label} · {period.comparisonLabel} · all figures in {currency}
            </p>
            <div className="mt-1.5">
              <Suspense fallback={null}>
                <SyncStatus />
              </Suspense>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ChannelFilter
              options={channels.map((channel) => ({
                id: channel.id,
                name: channel.name,
                href: hrefForChannel(channel.id),
              }))}
              activeId={activeChannelId}
              allHref={hrefForChannel(null)}
              unattributedHref={
                current.orders_without_channel > 0 || channelChoice.kind === "unattributed"
                  ? hrefForChannel(NO_CHANNEL)
                  : undefined
              }
              unattributedSelected={channelChoice.kind === "unattributed"}
            />
            <RangeSelector
              active={period.key}
              customLabel={period.key === "custom" ? period.label : undefined}
              keep={
                channelParamFor(channelChoice) === null
                  ? {}
                  : { channel: channelParamFor(channelChoice) as string }
              }
            />
          </div>
        </header>

        {scoped && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-2.5">
            <p className="text-sm">
              Showing <span className="font-medium">{activeChannelName}</span> only.
              Expenses and net profit are whole-business figures and are not
              split across channels.
            </p>
            <Button asChild size="sm" variant="outline" className="ml-auto rounded-4xl">
              <Link href={hrefForChannel(null)}>All channels</Link>
            </Button>
          </div>
        )}

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
            {/* ---- Needs attention ---------------------------------------- */}
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
                          <Link href="/alerts" className="text-sm underline-offset-4 hover:underline">
                            {alert.title}
                          </Link>
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

            {/* ---- Business health ---------------------------------------- */}
            <section className="mt-6" aria-label="Business health">
              <HealthCard health={health} currency={currency} />
            </section>

            {/* ---- Key figures -------------------------------------------- */}
            <section className="mt-6" aria-label="Headline figures">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                  value={formatMoney(
                    scoped ? (businessWide?.net_profit ?? null) : current.net_profit,
                    currency
                  )}
                  change={scoped ? null : pct("net_profit")}
                  explanation={METRICS.net_profit.definition}
                  secondary={scoped ? "Whole business" : undefined}
                  warning={
                    scoped
                      ? "Expenses are not recorded per channel, so net profit is shown for the whole business."
                      : marginWarning
                  }
                />
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
              </div>
            </section>

            {/* ---- What changed ------------------------------------------- */}
            <section className="mt-8" aria-label="What changed">
              <SectionHeading
                title="What changed"
                description="Against the previous period, and what moved it."
              />
              <Suspense fallback={<Skeleton height="h-52" />}>
                <ChangeSection
                  businessId={activeBusiness.id}
                  period={period}
                  scope={scope}
                  comparisons={comparisons}
                  currency={currency}
                  hrefForChannel={hrefForChannel}
                />
              </Suspense>
            </section>

            {/* ---- Channel intelligence ----------------------------------- */}
            <section className="mt-8" aria-label="Channel intelligence">
              <SectionHeading
                title="Channel intelligence"
                description="Revenue shows where you are busy. Margin shows where you are paid. Click a channel to filter everything above."
              />
              <Suspense fallback={<Skeleton height="h-96" />}>
                <ChannelSection
                  businessId={activeBusiness.id}
                  period={period}
                  currency={currency}
                  activeChannelId={activeChannelId}
                  hrefForChannel={hrefForChannel}
                />
              </Suspense>
            </section>

            {/* ---- Product intelligence ----------------------------------- */}
            <section className="mt-8" aria-label="Product intelligence">
              <SectionHeading
                title="Product intelligence"
                description="Line revenue excludes shipping and order-level discounts. Fees are shared across lines in proportion to their value — an allocation, not a charge paid per product."
              />
              <div className="overflow-hidden rounded-xl border border-border bg-card pt-3">
                <ProductIntelligence products={products} currency={currency} />
              </div>
            </section>

            {/* ---- Data quality ------------------------------------------- */}
            <section className="mt-8" aria-label="Data quality">
              <SectionHeading
                title="What is missing"
                description="What BizMind does not know, and what that does to the figures above."
              />
              <Suspense fallback={<Skeleton height="h-64" />}>
                <QualitySection
                  businessId={activeBusiness.id}
                  period={period}
                  scope={scope}
                  hrefForIssue={hrefForIssue}
                />
              </Suspense>
            </section>

            {/* ---- The analyst -------------------------------------------- */}
            <section className="mt-8" aria-label="Your business analyst">
              <SectionHeading
                title="Your business analyst"
                description="An explanation of the figures above. It never calculates one."
              />
              {/* Reads the same filters the page did, so the brief describes
                  what is on screen. The key remounts it when they change. */}
              <BusinessBrief key={briefKey} filters={briefFilters} />
            </section>

            {/* ---- Findings ----------------------------------------------- */}
            {insights.length > 0 && (
              <section className="mt-8" aria-label="Findings">
                <SectionHeading
                  title="Findings"
                  description="Produced by arithmetic, not judgement."
                />
                <InsightList insights={insights} currency={currency} />
              </section>
            )}

            <p className="mt-8 text-xs text-muted-foreground">
              Every figure here is calculated in the database from your own
              records. Nothing is estimated or generated.
            </p>
          </>
        )}
      </div>
    </AppShell>
  )
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-0.5 max-w-prose-comfortable text-sm text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

/** A section still loading. Sized to its content, so nothing jumps when it arrives. */
function Skeleton({ height }: { height: string }) {
  return (
    <div
      className={`${height} animate-pulse rounded-xl border border-border bg-muted/40`}
      aria-hidden
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Streamed sections                                                          */
/* -------------------------------------------------------------------------- */

async function ChangeSection({
  businessId,
  period,
  scope,
  comparisons,
  currency,
  hrefForChannel,
}: {
  businessId: string
  period: ResolvedPeriod
  scope: AnalyticsScope
  comparisons: MetricComparison[]
  currency: string
  hrefForChannel: (channel: string | null) => string
}) {
  const drivers = await getChangeDrivers(businessId, period, { scope, limit: 5 })

  return (
    <WhatChanged
      comparisons={comparisons}
      drivers={drivers}
      currency={currency}
      hrefForChannel={(key) => hrefForChannel(key === "unattributed" ? NO_CHANNEL : key)}
    />
  )
}

async function ChannelSection({
  businessId,
  period,
  currency,
  activeChannelId,
  hrefForChannel,
}: {
  businessId: string
  period: ResolvedPeriod
  currency: string
  activeChannelId: string | null
  hrefForChannel: (channel: string | null) => string
}) {
  // Always every channel: the chosen one is shown against the rest.
  const channels = await getChannelComparison(businessId, period)

  // Links are built here, in the server component. A function cannot be handed
  // to a client component -- React has no way to send one over the wire.
  const hrefs: Record<string, string> = {}
  for (const channel of channels) {
    const key = channel.channel_id ?? "unattributed"
    hrefs[key] = hrefForChannel(channel.channel_id ?? NO_CHANNEL)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <ChannelScatter
          channels={channels}
          currency={currency}
          activeChannelId={activeChannelId}
          hrefs={hrefs}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <ChannelIntelligence
          channels={channels}
          currency={currency}
          activeChannelId={activeChannelId}
          hrefFor={(id) => hrefForChannel(id === null ? NO_CHANNEL : id)}
        />
      </div>
    </div>
  )
}

async function QualitySection({
  businessId,
  period,
  scope,
  hrefForIssue,
}: {
  businessId: string
  period: ResolvedPeriod
  scope: AnalyticsScope
  hrefForIssue: (issue: string) => string
}) {
  const quality = await getDataQuality(businessId, period, { scope })

  if (!quality) {
    return (
      <p className="rounded-xl border border-border bg-card px-5 py-6 text-sm text-muted-foreground">
        Data quality could not be measured for this period.
      </p>
    )
  }

  return <QualityPanel quality={quality} hrefForIssue={(issue) => hrefForIssue(issue)} />
}
