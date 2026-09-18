import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import {
  ChartColumn,
  Download,
  FileSpreadsheet,
  Landmark,
  LineChart,
  Package,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { getExpensePeriods } from "@/features/expenses/queries"
import { LedgerFilters } from "@/features/ledger/components/ledger-filters"
import { firstParam, ledgerHref } from "@/features/ledger/params"
import { getLedgerPeriods, listLedgerAccounts } from "@/features/ledger/queries"
import { KpiCard } from "@/features/overview/components/kpi-card"
import {
  AccountsTable,
  AlertStrip,
  Card,
  ChangeAnalysis,
  CostBreakdown,
  DataHealth,
  Insights,
  NeedsAttention,
  PayoutsCard,
  ProductsTable,
  StatusRibbon,
} from "@/features/overview/components/sections"
import { TrendChart } from "@/features/overview/components/trend-chart"
import { WaterfallChart } from "@/features/overview/components/waterfall-chart"
import { getOverviewData, type OverviewRow } from "@/features/overview/queries"
import { formatMoney, formatPercent } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { compareMoney } from "@/services/analytics/money"
import { listAlerts } from "@/services/automation/alerts"
import { monthKeyOf, parseLedgerMonth, previousLedgerMonth, type LedgerMonth } from "@/services/ledger/period"
import { findings, openItems } from "@/services/overview/findings"

export const metadata: Metadata = {
  title: "Dashboard",
}

/**
 * The home dashboard, on the marketplace ledger.
 *
 * PERFORMS NO CALCULATIONS. Every figure, share, change against last month and
 * chart position is worked out in SQL (migration 0043, on the P&L engine) and
 * arrives as exact text or a finished percentage. This page picks the scope,
 * orders the sections and chooses the words.
 *
 * Scope is one currency -- all its marketplace accounts added up -- or one
 * account. Currencies are never combined (A12). Net profit belongs to the
 * whole currency because expenses are never allocated to an account (A7), so
 * an account view shows it only when that account is alone in its currency.
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

  // The scope: "all-AED", an account id, or by default the currency with the
  // most recent marketplace data.
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
  const month = parseLedgerMonth(firstParam(searchParams.month)) ?? monthOptions[0] ?? null
  if (month && !monthOptions.some((m) => m.key === month.key)) monthOptions.unshift(month)

  const data = currency && month ? await getOverviewData(activeBusiness.id, { currency, accountId }, month) : null
  const o = data?.overview ?? null

  const canImport = activeBusiness.role !== "VIEWER"
  const filterOptions = [
    ...currencies.map((cur) => {
      const n = accounts.filter((a) => a.currency === cur).length
      return { id: `${ALL_PREFIX}${cur}`, label: `All ${cur} marketplaces`, detail: `${n} account${n === 1 ? "" : "s"}` }
    }),
    ...accounts.map((a) => ({ id: a.id, label: a.label, detail: `${a.marketplace_code} · ${a.currency}` })),
  ]

  // The marketplace profit screen only has a combined view for 2+ accounts.
  const currencyAccounts = accounts.filter((a) => a.currency === currency)
  const ledgerScope = accountId ?? (currencyAccounts.length === 1 ? currencyAccounts[0].id : `${ALL_PREFIX}${currency}`)
  const scoped = (path: string) => ledgerHref(path, { account: ledgerScope, month: month?.key })
  const overviewHref = (id: string) => ledgerHref("/overview", { account: id, month: month?.key })

  const scopeAlerts = alerts.filter((a) => a.currency === null || a.currency === currency)
  const topProducts = (data?.products ?? [])
    // Unmatched SKUs are shown too (labelled), so a month before matching is not empty.
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
            <h1 className="font-heading text-2xl font-bold tracking-tight sm:text-3xl">Business overview</h1>
            <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
              Your marketplace sales, costs and profit, worked out from the marketplaces&apos; own reports.
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
            <LedgerFilters
              accounts={filterOptions}
              months={monthOptions.map((m) => ({ key: m.key, label: m.label }))}
              accountId={scopeValue}
              monthKey={month?.key ?? null}
              basePath="/overview"
            />

            {!month || !o || !data ? (
              <EmptyState
                title="No marketplace figures yet"
                body="Upload a settlement report and your dashboard fills in: sales, marketplace costs, contribution and expected payouts."
                href="/imports/settlement"
                action="Upload a report"
              />
            ) : !o.has_marketplace_data ? (
              <EmptyState
                title={`No marketplace lines in ${month.label}`}
                body="Choose another month, or upload the report that covers this one."
                href="/imports/settlement"
                action="Upload a report"
              />
            ) : (
              <Dashboard
                o={o}
                data={data}
                month={month}
                accountId={accountId}
                scoped={scoped}
                overviewHref={overviewHref}
                allHref={overviewHref(`${ALL_PREFIX}${currency}`)}
                alerts={scopeAlerts}
                topProducts={topProducts}
              />
            )}

            <QuickActions canImport={canImport} scoped={scoped} monthKey={month?.key ?? null} />
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
  month,
  accountId,
  scoped,
  overviewHref,
  allHref,
  alerts,
  topProducts,
}: {
  o: OverviewRow
  data: NonNullable<Awaited<ReturnType<typeof getOverviewData>>>
  month: LedgerMonth
  accountId: string | null
  scoped: (path: string) => string
  overviewHref: (id: string) => string
  allHref: string
  alerts: Parameters<typeof AlertStrip>[0]["alerts"]
  topProducts: Parameters<typeof ProductsTable>[0]["rows"]
}) {
  const money = (v: string | null | undefined) => formatMoney(v, o.currency)
  const previous = previousLedgerMonth(month)
  const vs = `vs ${previous.label}`
  const soFar = (v: string | null) => `So far: ${money(v)} — not final`

  return (
    <>
      <StatusRibbon o={o} monthLabel={month.label} />
      <AlertStrip alerts={alerts} />

      {/* ---- headline figures -------------------------------------------- */}
      <section aria-label="Headline figures" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 2xl:grid-cols-6">
        <KpiCard
          label="Gross sales"
          value={money(o.gross_sales)}
          status={o.figures_status}
          change={o.gross_sales_change_pct}
          changeLabel={vs}
          note="Orders as the marketplaces reported them"
          href={scoped("/ledger")}
        />
        <KpiCard
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
          label="Contribution"
          value={o.contribution === null ? "Incomplete" : money(o.contribution)}
          status={o.contribution_status}
          change={o.contribution_change_pct}
          changeLabel={vs}
          emphasis
          note={
            o.contribution === null
              ? soFar(o.contribution_before_open_items)
              : `${formatPercent(o.contribution_margin_pct)} margin, before product costs`
          }
          href={scoped("/ledger")}
        />
        <KpiCard
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
            label="Net profit"
            value={o.net_profit === null ? "Incomplete" : money(o.net_profit)}
            status={o.net_profit_status}
            change={o.net_profit_change_pct}
            changeLabel={vs}
            emphasis
            note={
              o.net_profit === null
                ? soFar(o.net_profit_before_open_items)
                : `${formatPercent(o.net_margin_pct)} margin, after operating expenses`
            }
            href={ledgerHref("/ledger/expenses", { month: month.key })}
          />
        ) : (
          <KpiCard
            label="Net profit"
            value="—"
            note={`Operating expenses belong to the whole business, so net profit is shown for all ${o.currency} accounts together.`}
            href={allHref}
          />
        )}
      </section>

      <NeedsAttention items={openItems(o, month.key)} />

      {/* ---- where the money goes ---------------------------------------- */}
      <Card
        title="Where your sales money goes"
        description={`From gross sales down to ${o.net_available ? "net profit" : "gross profit"}, for ${month.label}. Hover a bar for its exact amount.`}
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

      <Card
        title="Sales and contribution, day by day"
        description={`Every day of ${month.label} by the date each line was posted.`}
        icon={LineChart}
      >
        <div className="px-3 py-4 sm:px-5">
          <TrendChart points={data.daily} currency={o.currency} contributionFinal={o.contribution_status === "FINAL"} />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <CostBreakdown rows={data.costs} o={o} linesHref={scoped("/ledger")} />
        <ChangeAnalysis o={o} previousLabel={previous.label} />
      </div>

      {data.accounts.length > 1 && (
        <AccountsTable rows={data.accounts} currency={o.currency} selected={accountId} hrefFor={overviewHref} />
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <PayoutsCard o={o} payouts={data.payouts} href={ledgerHref("/ledger/payouts", { month: month.key })} />
        <DataHealth o={o} monthKey={month.key} />
      </div>

      <ProductsTable rows={topProducts} currency={o.currency} href={scoped("/ledger/products")} />

      <Insights items={findings(o, o.currency, month.key, scoped("/ledger"))} />
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
