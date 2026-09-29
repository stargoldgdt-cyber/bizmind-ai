import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import {
  Boxes,
  CalendarRange,
  ChartColumn,
  CreditCard,
  Download,
  FileSpreadsheet,
  Landmark,
  LineChart,
  Megaphone,
  Package,
  PiggyBank,
  Receipt,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  Upload,
  Wallet,
} from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { getExpensePeriods } from "@/features/expenses/queries"
import { firstParam, ledgerHref } from "@/features/ledger/params"
import { getLedgerPeriods, listLedgerAccounts } from "@/features/ledger/queries"
import { CostDonutChart } from "@/features/overview/components/cost-donut-chart"
import { Greeting } from "@/features/overview/components/greeting"
import { InsightCard } from "@/features/overview/components/insight-card"
import { KpiCard } from "@/features/overview/components/kpi-card"
import { MonthlyTrend } from "@/features/overview/components/monthly-trend"
import { OverviewFilters } from "@/features/overview/components/overview-filters"
import { ProductsTable } from "@/features/overview/components/products-table"
import { ProfitBridgeChart } from "@/features/overview/components/profit-bridge-chart"
import {
  AccountsTable,
  AlertStrip,
  Card,
  DataHealth,
  Insights,
  MarketplaceCards,
  NeedsAttention,
  PayoutsCard,
  StatusRibbon,
} from "@/features/overview/components/sections"
import { TrendChart } from "@/features/overview/components/trend-chart"
import { WaterfallChart } from "@/features/overview/components/waterfall-chart"
import { getOverviewData, type OverviewData, type OverviewRow } from "@/features/overview/queries"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { compareMoney } from "@/services/analytics/money"
import { listAlerts } from "@/services/automation/alerts"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"
import { contributionStory, findings, openItems } from "@/services/overview/findings"
import { isPeriodKey, resolvePeriod, type OverviewPeriod } from "@/services/overview/period"

export const metadata: Metadata = {
  title: "Dashboard",
}

/**
 * The executive dashboard: the whole business at a glance (owner request,
 * 2026-09-21).
 *
 * PERFORMS NO CALCULATIONS. Every figure, share, change against the previous
 * period and chart position is worked out in SQL (migrations 0043 and 0049, on
 * the P&L engine) and arrives as exact text or a finished percentage. This
 * page picks the scope and period, orders the sections and chooses the words.
 *
 * Scope is the whole business -- every marketplace account in one currency,
 * added up -- or one account. Currencies are never combined (A12): a business
 * selling in two currencies switches between them. Net profit belongs to the
 * whole currency because expenses are never allocated to an account (A7).
 *
 * The period is whole months ending on a chosen month (by default the latest
 * month with data): one month, three, the year to date or twelve. It is
 * compared with the same number of months just before it.
 *
 * Nothing incomplete looks final (B1), and an expected payout is never called
 * received: the bank side reads "Not connected" until a bank source exists.
 */

const ALL_PREFIX = "all-"

export default async function OverviewPage(props: PageProps<"/overview">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])
  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, accounts, periods, expensePeriods, alerts] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listLedgerAccounts(activeBusiness.id),
    getLedgerPeriods(activeBusiness.id),
    getExpensePeriods(activeBusiness.id),
    listAlerts(activeBusiness.id, { status: "OPEN", limit: 20 }),
  ])

  const currencies = [...new Set(accounts.map((a) => a.currency))].sort()

  // The scope: "all-AED" (the whole business in AED), an account id, or by
  // default the whole business in the currency with the most recent data.
  const requested = firstParam(searchParams.account)
  const requestedAccount = accounts.find((a) => a.id === requested) ?? null
  const requestedCurrency = requested?.startsWith(ALL_PREFIX) ? requested.slice(ALL_PREFIX.length) : null
  const latest = [...periods].sort((a, b) => b.month.localeCompare(a.month))[0]
  const currency =
    requestedAccount?.currency ??
    (requestedCurrency && currencies.includes(requestedCurrency) ? requestedCurrency : null) ??
    latest?.currency ??
    currencies[0] ??
    null
  const accountId = requestedAccount?.id ?? null
  const scopeValue = accountId ?? `${ALL_PREFIX}${currency}`

  const scopeAccounts = accounts.filter((a) => (accountId ? a.id === accountId : a.currency === currency))
  const scopeIds = new Set(scopeAccounts.map((a) => a.id))
  const monthKeys = [
    ...new Set([
      ...periods.filter((p) => scopeIds.has(p.marketplace_account_id)).map((p) => monthKeyOf(p.month)),
      ...expensePeriods.filter((p) => p.currency === currency).map((p) => monthKeyOf(p.month)),
    ]),
  ]
    .sort()
    .reverse()
  const monthOptions = monthKeys.map((key) => parseLedgerMonth(key)).filter((m): m is LedgerMonth => m !== null)
  const endMonth = parseLedgerMonth(firstParam(searchParams.month)) ?? monthOptions[0] ?? null
  if (endMonth && !monthOptions.some((m) => m.key === endMonth.key)) monthOptions.unshift(endMonth)
  const requestedPeriod = firstParam(searchParams.period)
  const periodKey = isPeriodKey(requestedPeriod) ? requestedPeriod : "1m"
  const period = endMonth ? resolvePeriod(periodKey, endMonth) : null

  const data = currency && period ? await getOverviewData(activeBusiness.id, { currency, accountId }, period) : null
  const o = data?.overview ?? null

  const canImport = activeBusiness.role !== "VIEWER"
  const scopeOptions = [
    ...currencies.map((cur) => {
      const n = accounts.filter((a) => a.currency === cur).length
      return {
        id: `${ALL_PREFIX}${cur}`,
        label: currencies.length > 1 ? `Whole business (${cur})` : "Whole business",
        detail: `${n} account${n === 1 ? "" : "s"}`,
      }
    }),
    ...accounts.map((a) => ({ id: a.id, label: a.label, detail: `${a.marketplace_code} · ${a.currency}` })),
  ]

  // The marketplace profit screen only has a combined view for 2+ accounts;
  // month screens open on the period's last month.
  const currencyAccounts = accounts.filter((a) => a.currency === currency)
  const ledgerScope = accountId ?? (currencyAccounts.length === 1 ? currencyAccounts[0].id : `${ALL_PREFIX}${currency}`)
  const scoped = (path: string) => ledgerHref(path, { account: ledgerScope, month: endMonth?.key })
  const overviewHref = (id: string) => ledgerHref("/overview", { account: id, period: periodKey, month: endMonth?.key })

  const scopeAlerts = alerts.filter((a) => a.currency === null || a.currency === currency)
  const topProducts = (data?.products ?? [])
    // Unmatched SKUs are shown too (labelled), so a period before matching is not empty.
    .filter((p) => p.row_kind === "PRODUCT" || p.row_kind === "UNMAPPED_SKU")
    .sort((a, b) => compareMoney(b.net_sales, a.net_sales))
    .slice(0, 5)

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-7xl gap-6">
        {/* ---- header ------------------------------------------------------ */}
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="font-heading text-2xl font-bold tracking-tight sm:text-3xl">
              <Greeting name={profile?.full_name?.split(" ")[0] ?? null} />
            </h1>
            <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
              {period
                ? `Here's your business performance for ${period.label}.`
                : "Every marketplace you sell on, together: sales, costs and profit, worked out from the marketplaces' own reports."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" className="rounded-4xl">
              <Link href="/ledger/reports">
                <Download className="size-4" aria-hidden />
                Export
              </Link>
            </Button>
            <Button asChild className="rounded-4xl">
              <Link href="/ledger/ask">
                <Sparkles className="size-4" aria-hidden />
                Ask BizMind
              </Link>
            </Button>
          </div>
        </header>

        {accounts.length === 0 || !currency ? (
          <EmptyState
            title="Add your first marketplace account"
            body="Figures are worked out per marketplace account, in its own currency. Add Amazon, noon or Carrefour, then upload a settlement report."
            href="/marketplaces"
            action="Marketplace accounts"
          />
        ) : (
          <>
            <OverviewFilters
              scopes={scopeOptions}
              scope={scopeValue}
              period={periodKey}
              months={monthOptions.map((m) => ({ key: m.key, label: m.label }))}
              endMonth={endMonth?.key ?? null}
            />

            {!period || !o || !data ? (
              <EmptyState
                title="No marketplace figures yet"
                body="Upload a settlement report and your dashboard fills in: sales, marketplace costs, contribution and expected payouts."
                href="/imports/settlement"
                action="Upload a report"
              />
            ) : !o.has_marketplace_data ? (
              <EmptyState
                title={`No marketplace lines in ${period.label}`}
                body="Choose another period, or upload the reports that cover this one."
                href="/imports/settlement"
                action="Upload a report"
              />
            ) : (
              <Dashboard
                o={o}
                data={data}
                period={period}
                accountId={accountId}
                scoped={scoped}
                overviewHref={overviewHref}
                allHref={overviewHref(`${ALL_PREFIX}${currency}`)}
                alerts={scopeAlerts}
                topProducts={topProducts}
              />
            )}

            <QuickActions canImport={canImport} scoped={scoped} monthKey={endMonth?.key ?? null} />
          </>
        )}
      </div>
    </AppShell>
  )
}

/* ---- the dashboard, once there is data --------------------------------------- */

function Dashboard({
  o,
  data,
  period,
  accountId,
  scoped,
  overviewHref,
  allHref,
  alerts,
  topProducts,
}: {
  o: OverviewRow
  data: OverviewData
  period: OverviewPeriod
  accountId: string | null
  scoped: (path: string) => string
  overviewHref: (id: string) => string
  allHref: string
  alerts: Parameters<typeof AlertStrip>[0]["alerts"]
  topProducts: Parameters<typeof ProductsTable>[0]["rows"]
}) {
  const money = (v: string | null | undefined) => formatMoney(v, o.currency)
  const vs = `vs ${period.previousLabel}`
  const soFar = (v: string | null) => `So far: ${money(v)} — not final`
  const monthKey = period.end.key

  return (
    <>
      <StatusRibbon o={o} monthLabel={period.label} />
      <AlertStrip alerts={alerts} />

      {/* ---- headline figures -------------------------------------------- */}
      <section aria-label="Headline figures" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-4">
        <KpiCard
          icon={ShoppingBag}
          label="Gross sales"
          value={money(o.gross_sales)}
          status={o.figures_status}
          change={o.gross_sales_change_pct}
          changeLabel={vs}
          note="Orders as the marketplaces reported them"
          href={scoped("/ledger")}
        />
        <KpiCard
          icon={Receipt}
          label="Net sales"
          value={money(o.net_sales)}
          status={o.figures_status}
          change={o.net_sales_change_pct}
          changeLabel={vs}
          note={
            o.refunds_pct_of_gross === null
              ? "After refunds and seller discounts"
              : `After refunds (${formatPercent(o.refunds_pct_of_gross)} of gross) and discounts`
          }
        />
        <KpiCard
          icon={CreditCard}
          label="Marketplace costs"
          value={money(o.marketplace_costs)}
          status={o.figures_status}
          change={o.marketplace_costs_change_pct}
          changeLabel={vs}
          risingIsGood={false}
          note={
            o.costs_pct_of_net_sales === null
              ? "Fees, fulfilment and advertising"
              : `Fees, fulfilment and ads: ${formatPercent(o.costs_pct_of_net_sales)} of net sales`
          }
        />
        <KpiCard
          icon={Megaphone}
          label="Advertising"
          value={money(o.advertising)}
          status={o.figures_status}
          risingIsGood={false}
          note={
            o.advertising_pct_of_net_sales === null
              ? "Marketplace advertising spend"
              : `${formatPercent(o.advertising_pct_of_net_sales)} of net sales`
          }
        />
        <KpiCard
          icon={Boxes}
          label="Cost of goods"
          value={o.cogs === null ? "Incomplete" : money(o.cogs)}
          status={o.gross_profit_status}
          risingIsGood={false}
          note={`${formatNumber(o.units_sold, 4)} units sold`}
          href={scoped("/ledger/products")}
        />
        <KpiCard
          icon={PiggyBank}
          label="Contribution"
          value={o.contribution === null ? "Incomplete" : money(o.contribution)}
          status={o.contribution_status}
          change={o.contribution_change_pct}
          changeLabel={vs}
          note={
            o.contribution === null
              ? soFar(o.contribution_before_open_items)
              : `${formatPercent(o.contribution_margin_pct)} margin, before product costs`
          }
          href={scoped("/ledger")}
        />
        <KpiCard
          icon={TrendingUp}
          label="Gross profit"
          value={o.gross_profit === null ? "Incomplete" : money(o.gross_profit)}
          status={o.gross_profit_status}
          change={o.gross_profit_change_pct}
          changeLabel={vs}
          note={
            o.gross_profit === null
              ? soFar(o.gross_profit_before_open_items)
              : `${formatPercent(o.gross_margin_pct)} margin, after cost of goods`
          }
          href={scoped("/ledger/products")}
        />
        {o.net_available ? (
          <KpiCard
            icon={Wallet}
            label="Net profit"
            value={o.net_profit === null ? "Incomplete" : money(o.net_profit)}
            status={o.net_profit_status}
            change={o.net_profit_change_pct}
            changeLabel={vs}
            note={
              o.net_profit === null
                ? soFar(o.net_profit_before_open_items)
                : `${formatPercent(o.net_margin_pct)} margin, after operating expenses`
            }
            href={ledgerHref("/ledger/expenses", { month: monthKey })}
          />
        ) : (
          <KpiCard
            icon={Wallet}
            label="Net profit"
            value="—"
            note={`Operating expenses belong to the whole business, so net profit is shown for the whole business.`}
            href={allHref}
          />
        )}
      </section>

      {/* ---- the sharpest observation, given the reference's prominence -- */}
      <InsightCard
        story={contributionStory(o, data.bridge, period.previousLabel, scoped("/ledger"))}
        items={findings(o, o.currency, monthKey, scoped("/ledger"))}
      />

      {/* ---- each marketplace -------------------------------------------- */}
      {data.accounts.length > 1 && (
        <MarketplaceCards rows={data.accounts} currency={o.currency} selected={accountId} hrefFor={overviewHref} />
      )}

      {/* ---- month by month ------------------------------------------------ */}
      <Card
        title="Month by month"
        description={
          period.single
            ? `Net sales per marketplace and contribution over the 12 months to ${period.end.label}.`
            : `Net sales per marketplace and contribution, ${period.label}.`
        }
        icon={CalendarRange}
      >
        <div className="px-3 py-4 sm:px-5">
          <MonthlyTrend points={data.monthly} currency={o.currency} />
        </div>
      </Card>

      <NeedsAttention items={openItems(o, monthKey)} />

      {/* ---- where the money goes ---------------------------------------- */}
      <Card
        title="Where your sales money goes"
        description={`From gross sales down to ${o.net_available ? "net profit" : "gross profit"}, ${period.label}. Hover a bar for its exact amount.`}
        icon={ChartColumn}
        aside={
          <Link href={scoped("/ledger")} className="text-xs font-medium underline-offset-4 hover:underline">
            Line-by-line statement
          </Link>
        }
      >
        <div className="pt-4">
          <WaterfallChart steps={data.waterfall} currency={o.currency} />
        </div>
      </Card>

      {period.single && (
        <Card
          title="Sales and contribution, day by day"
          description={`Every day of ${period.label} by the date each line was posted.`}
          icon={LineChart}
        >
          <div className="px-3 py-4 sm:px-5">
            <TrendChart points={data.daily} currency={o.currency} contributionFinal={o.contribution_status === "FINAL"} />
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Where your money goes"
          description="What the marketplaces kept in this period, largest first."
          icon={ChartColumn}
          aside={
            o.costs_pct_of_net_sales !== null ? (
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium tabular-nums">
                {formatPercent(o.costs_pct_of_net_sales)} of net sales
              </span>
            ) : undefined
          }
        >
          <CostDonutChart rows={data.costs} total={o.marketplace_costs} currency={o.currency} />
          <Link href={scoped("/ledger")} className="border-t border-border px-5 py-2.5 text-xs font-medium underline-offset-4 hover:underline">
            See every line behind these costs
          </Link>
        </Card>
        <Card
          title="Why did contribution change?"
          description={
            o.prev_has_marketplace_data
              ? `Previous contribution to current, ${period.previousLabel} to ${period.label}. Each step is that line's own dollar move.`
              : `There are no marketplace figures for ${period.previousLabel}, so nothing is compared yet.`
          }
          icon={LineChart}
        >
          <div className="pt-4">
            <ProfitBridgeChart steps={data.bridge} currency={o.currency} />
          </div>
          {o.advertising_pct_of_net_sales !== null && (
            <p className="mt-auto border-t border-border bg-muted/40 px-5 py-3 text-xs text-muted-foreground">
              Marketplace advertising in this period: {money(o.advertising)}, {formatPercent(o.advertising_pct_of_net_sales)} of net sales.
            </p>
          )}
        </Card>
      </div>

      {data.accounts.length > 1 && (
        <AccountsTable rows={data.accounts} currency={o.currency} selected={accountId} hrefFor={overviewHref} />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <PayoutsCard o={o} payouts={data.payouts} href={ledgerHref("/ledger/payouts", { month: monthKey })} />
        <DataHealth o={o} monthKey={monthKey} />
      </div>

      <ProductsTable rows={topProducts} currency={o.currency} href={scoped("/ledger/products")} />

      <Insights items={findings(o, o.currency, monthKey, scoped("/ledger"))} />
    </>
  )
}

/* ---- the next click ----------------------------------------------------------- */

function QuickActions({
  canImport,
  scoped,
  monthKey,
}: {
  canImport: boolean
  scoped: (path: string) => string
  monthKey: string | null
}) {
  const actions = [
    ...(canImport ? [{ href: "/imports/settlement", label: "Upload marketplace report", icon: Upload, primary: true }] : []),
    { href: scoped("/ledger/products"), label: "Product profit", icon: Package, primary: false },
    { href: ledgerHref("/ledger/payouts", { month: monthKey }), label: "Payouts and cashflow", icon: Landmark, primary: false },
    { href: "/ledger/quality", label: "Data quality", icon: ShieldCheck, primary: false },
    { href: "/ledger/reports", label: "Reports and exports", icon: FileSpreadsheet, primary: false },
  ]
  return (
    <nav aria-label="Quick actions" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {actions.map((a) => (
        <Link
          key={a.label}
          href={a.href}
          className={
            a.primary
              ? "col-span-2 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 sm:col-span-1"
              : "inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm font-medium hover:border-primary/40 hover:text-primary"
          }
        >
          <a.icon className="size-4" aria-hidden />
          {a.label}
        </Link>
      ))}
    </nav>
  )
}

function EmptyState({ title, body, href, action }: { title: string; body: string; href: string; action: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-10 text-center">
      <p className="font-heading text-lg font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      <Button asChild size="sm" className="mt-4 rounded-4xl">
        <Link href={href}>{action}</Link>
      </Button>
    </div>
  )
}
