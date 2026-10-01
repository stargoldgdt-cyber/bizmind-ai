import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import {
  Boxes,
  Calculator,
  CircleAlert,
  CircleCheck,
  Coins,
  CreditCard,
  Download,
  Info,
  Megaphone,
  Package,
  Percent,
  PiggyBank,
  Receipt,
  ShoppingBag,
  TrendingUp,
  Truck,
  Upload,
} from "lucide-react"
import type { ReactNode } from "react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { getNetProfit, type NetProfitRow } from "@/features/expenses/queries"
import { LedgerFilters } from "@/features/ledger/components/ledger-filters"
import { PnlPeriodPicker } from "@/features/ledger/components/pnl-period-picker"
import { StatusLabel } from "@/features/ledger/components/status-label"
import { TransactionClassification, type BreakdownRow } from "@/features/ledger/components/transaction-classification"
import { firstParam, ledgerHref } from "@/features/ledger/params"
import {
  getCurrencyMonth,
  getLedgerMonth,
  getLedgerPeriods,
  listLedgerAccounts,
  type CurrencyMonthData,
  type ExpectedPayoutRow,
  type LedgerAccount,
  type LedgerMonthData,
  type PnlSummaryChangeRow,
} from "@/features/ledger/queries"
import { KpiCard } from "@/features/overview/components/kpi-card"
import { WaterfallChart } from "@/features/overview/components/waterfall-chart"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { INPUT_VAT_TREATMENT_LABEL, formatLedgerDay, unsignedAmount } from "@/services/ledger/display"
import type { PnlSummaryRow } from "@/services/ledger/export"
import {
  isPnlPeriodKey,
  isSingleMonthPeriod,
  previousPeriodLabel,
  resolvePnlPeriod,
  type PnlPeriod,
  type PnlPeriodKey,
} from "@/services/ledger/pnl-period"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"
import {
  BANK_RECEIPT_STATUS_LABEL,
  PAYOUT_SOURCE_LABEL,
  PAYOUT_STATUS_HELP,
  PAYOUT_STATUS_LABEL,
} from "@/services/payouts/labels"

export const metadata: Metadata = {
  title: "Marketplace P&L",
}

/**
 * Marketplace P&L: the live dashboard on the ledger (GCC Phases 4-9),
 * refined into a marketplace-agnostic report (owner spec, 2026-09-26).
 *
 * PERFORMS NO CALCULATIONS. Every figure is computed by the P&L engine in SQL
 * (pnl_summary, pnl_breakdown, pnl_settlements, dashboard_waterfall_steps) and
 * arrives as exact text or an already-computed ratio. This page decides only
 * what to show and how to say it -- including the KPI groups, the waterfall
 * and the period picker, none of which do arithmetic on a money field.
 *
 * NOTHING INCOMPLETE LOOKS FINAL. While a code is unrecognised, a row is
 * unreadable, fee VAT is not separated or the VAT setting is Unknown, the
 * affected figures carry an Incomplete label and contribution shows no number
 * -- only an informational figure labelled "not final" (decision B1).
 * Gross profit (contribution - COGS, decision B16) is likewise shown only
 * when contribution is final and every sold unit has a product and a cost.
 * Net profit (gross profit - operating expenses) is business-wide, so it is
 * shown for a whole currency: the combined view, or an account that is the
 * only one in its currency. Expenses are never allocated to an account (A7).
 *
 * MONTHLY P&L, SETTLEMENTS and RECONCILIATION are kept apart (item 14 of the
 * spec): the P&L tab never reads a settlement payout, and the Settlements /
 * Reconciliation tabs never feed a profit figure. Marketplace raw codes map
 * into the same universal categories regardless of marketplace (Amazon
 * referral fee, noon commission -- both Marketplace Fees); only the mapping
 * differs per marketplace, never the reporting categories or this UI.
 *
 * One account, or every account in one currency added up by the engine.
 * Accounts in different currencies are never combined (A12). The account,
 * the month and the period all live in the URL.
 */

const ALL_PREFIX = "all-"

export default async function LedgerOverviewPage(props: PageProps<"/ledger">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, accounts, periods] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listLedgerAccounts(activeBusiness.id),
    getLedgerPeriods(activeBusiness.id),
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

  /*
   * This Month / Last Month / This Quarter / This Year / Custom Range
   * (owner spec, 2026-09-26). The anchor is always `month` -- the SAME month
   * the dropdown above shows selected (which itself defaults to the latest
   * month with data). "This Month" and "Custom Range" both mean exactly that
   * month; "Last Month" / "This Quarter" / "This Year" are worked out from
   * it. The dropdown and the period picker must never disagree about which
   * month is on screen, so nothing here reads a second, independent notion
   * of "latest month" -- that was the bug (period silently overriding the
   * dropdown's own choice). With no `period` param, periodKey is
   * "this_month" and period resolves to exactly `month`'s own range -- no
   * existing link into /ledger changes behaviour.
   */
  const requestedPeriod = firstParam(searchParams.period)
  const periodKey: PnlPeriodKey = isPnlPeriodKey(requestedPeriod) ? requestedPeriod : "this_month"
  const period: PnlPeriod | null = month ? resolvePnlPeriod(periodKey, month, month) : null

  const single = account && period ? await getLedgerMonth(activeBusiness.id, account.id, period) : null
  const group = combined && period ? await getCurrencyMonth(activeBusiness.id, combined, period) : null
  const netCurrency = combined ?? (account && byCurrency.get(account.currency)?.length === 1 ? account.currency : null)
  const net = netCurrency && month ? await getNetProfit(activeBusiness.id, netCurrency, month) : null
  const canImport = activeBusiness.role !== "VIEWER"
  const isOwner = activeBusiness.role === "OWNER"

  const filterOptions = [
    ...accounts.map((a) => ({ id: a.id, label: a.label, detail: `${a.marketplace_code} · ${a.currency}` })),
    ...currencyGroups.map(([currency, list]) => ({
      id: `${ALL_PREFIX}${currency}`,
      label: `All ${currency} accounts`,
      detail: `${list.length} accounts, added up`,
    })),
  ]

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-6xl gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Marketplace P&amp;L</h1>
            <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
              Worked out from your marketplaces&apos; own reports, classified automatically into the same
              categories for every marketplace. Every figure opens into the lines behind it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {single?.summary && account && month && (
              <Button asChild variant="outline" className="rounded-4xl">
                <a href={ledgerHref("/api/v1/ledger/export", { account: account.id, month: month.key })}>
                  <Download className="size-4" aria-hidden />
                  Export for checking
                </a>
              </Button>
            )}
            {canImport && (
              <Button asChild className="rounded-4xl">
                <Link href="/imports/settlement">
                  <Upload className="size-4" aria-hidden />
                  Upload a report
                </Link>
              </Button>
            )}
          </div>
        </div>

        {accounts.length === 0 ? (
          <EmptyState
            title="Add a marketplace account first"
            body="Figures are worked out per marketplace account, in its own currency."
            href="/marketplaces"
            action="Marketplace accounts"
          />
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <LedgerFilters
                accounts={filterOptions}
                months={monthOptions.map((m) => ({ key: m.key, label: m.label }))}
                accountId={combined ? `${ALL_PREFIX}${combined}` : (account?.id ?? "")}
                monthKey={month?.key ?? null}
              />
              <PnlPeriodPicker period={periodKey} />
            </div>

            {!month || !period ? (
              <EmptyState
                title="No marketplace lines for this choice yet"
                body="Upload a marketplace report for this account and its figures appear here."
                href="/imports/settlement"
                action="Upload a report"
              />
            ) : combined && group ? (
              !group.total ? (
                <NoLines month={month} />
              ) : (
                <>
                  <CombinedView data={group} total={group.total} month={month} period={period} isOwner={isOwner} />
                  {net && <NetProfitSection net={net} month={month} />}
                </>
              )
            ) : single && account ? (
              !single.summary ? (
                <NoLines month={month} />
              ) : (
                <>
                  <MonthView
                    summary={single.summary}
                    data={single}
                    account={account}
                    month={month}
                    period={period}
                    isOwner={isOwner}
                  />
                  {net ? (
                    <NetProfitSection net={net} month={month} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Net profit is worked out for all your {account.currency} accounts together, because
                      operating expenses belong to the whole business.{" "}
                      <Link
                        href={ledgerHref("/ledger", { account: `${ALL_PREFIX}${account.currency}`, month: month.key })}
                        className="font-medium text-foreground underline underline-offset-4"
                      >
                        See all {account.currency} accounts
                      </Link>
                    </p>
                  )}
                </>
              )
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  )
}

/* ---- what is still open ----------------------------------------------------- */

function OpenItems({
  s,
  period,
  isOwner,
  reviewHref,
}: {
  s: PnlSummaryRow
  /** Only the label is read here -- a LedgerMonth or a PnlPeriod both work. */
  period: { label: string }
  isOwner: boolean
  reviewHref?: string
}) {
  const money = (value: string | null | undefined) => formatMoney(value, s.currency)
  const reasons = s.incomplete_reasons
  const incomplete = s.contribution_status === "INCOMPLETE" || s.figures_status === "INCOMPLETE"

  return (
    <>
      {incomplete && (
        <section role="status" className="rounded-xl border border-warning/40 bg-warning-subtle px-5 py-4">
          <div className="flex gap-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning-strong" aria-hidden />
            <div className="grid gap-2 text-sm">
              <p className="font-medium">Some figures for {period.label} are not final yet</p>
              <ul className="grid gap-1.5">
                {reasons.includes("VAT_TREATMENT_UNKNOWN") && (
                  <li>
                    VAT treatment unknown: {money(unsignedAmount(s.input_vat_unresolved))} of VAT charged on
                    fees is not counted either way, so contribution has no final figure.{" "}
                    {isOwner ? (
                      <Link href="/marketplaces" className="font-medium underline underline-offset-4">
                        Set VAT on fees
                      </Link>
                    ) : (
                      "Ask the owner to set VAT on fees."
                    )}
                  </li>
                )}
                {reasons.includes("FEE_VAT_NOT_SEPARATED") && (
                  <li>
                    Some fees in {period.label} still include VAT that has not been separated, so fees
                    and contribution are not final. For noon, upload the month&apos;s Invoices and Credit
                    Notes. Amazon&apos;s Paid Services Fee arrives with its VAT inside it, and no file
                    separates it yet.{" "}
                    <Link href="/imports/settlement" className="font-medium underline underline-offset-4">
                      Upload them
                    </Link>
                  </li>
                )}
                {reasons.includes("UNKNOWN_LINES") && (
                  <li>
                    {formatNumber(s.unknown_lines)} line{s.unknown_lines === 1 ? " uses" : "s use"} a code
                    BizMind does not recognise yet ({money(s.unknown_amount)}), so every figure is
                    incomplete.{" "}
                    <Link href="/ledger/quality" className="font-medium underline underline-offset-4">
                      Review in data quality
                    </Link>
                  </li>
                )}
                {reasons.includes("ROW_ERRORS") && (
                  <li>
                    {formatNumber(s.row_errors)} row{s.row_errors === 1 ? "" : "s"} in these files could not
                    be read.{" "}
                    <Link href="/imports" className="font-medium underline underline-offset-4">
                      See the files
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </section>
      )}

      {(s.gross_profit_reasons.includes("SKU_NOT_MAPPED") || s.gross_profit_reasons.includes("COST_MISSING")) && (
        <section role="status" className="rounded-xl border border-warning/40 bg-warning-subtle px-5 py-4">
          <div className="flex gap-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning-strong" aria-hidden />
            <div className="grid gap-2 text-sm">
              <p className="font-medium">Gross profit for {period.label} needs product costs</p>
              <ul className="grid gap-1.5">
                {s.gross_profit_reasons.includes("SKU_NOT_MAPPED") && (
                  <li>
                    {formatNumber(s.units_without_product, 4)} unit(s) sold under SKUs not yet matched to one of your
                    products.{" "}
                    <Link href="/catalog#needs-attention" className="font-medium underline underline-offset-4">
                      Match SKUs
                    </Link>
                  </li>
                )}
                {s.gross_profit_reasons.includes("COST_MISSING") && (
                  <li>
                    {formatNumber(s.units_without_cost, 4)} unit(s) sold of products with no cost in {s.currency} on
                    the sale date.{" "}
                    <Link href="/catalog" className="font-medium underline underline-offset-4">
                      Add costs
                    </Link>
                  </li>
                )}
                <li className="text-muted-foreground">
                  Sales without a known cost: {money(s.sales_without_cost)}.
                </li>
              </ul>
            </div>
          </div>
        </section>
      )}

      {s.review_lines > 0 && (
        <section className="flex gap-3 rounded-xl border border-info/40 bg-info-subtle px-5 py-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-info-strong" aria-hidden />
          <p>
            {formatNumber(s.review_lines)} line{s.review_lines === 1 ? " is" : "s are"} counted with a
            medium-confidence rule ({money(s.review_amount)}).{" "}
            <Link href={reviewHref ?? "/ledger/quality"} className="font-medium underline underline-offset-4">
              Check them
            </Link>
          </p>
        </section>
      )}
    </>
  )
}

function contributionNote(s: PnlSummaryRow): string {
  if (s.contribution !== null) return "Before product costs and operating expenses"
  const onlyVatSetting = s.incomplete_reasons.length === 1 && s.incomplete_reasons[0] === "VAT_TREATMENT_UNKNOWN"
  return `${onlyVatSetting ? "Contribution before fee-VAT treatment" : "From recognised lines only"}: ${formatMoney(
    s.contribution_before_open_items,
    s.currency
  )} — not final`
}

/**
 * Sales / Marketplace costs / Profitability (owner spec, 2026-09-26). Every
 * value is read straight off `PnlSummaryRow` -- orders, average order value,
 * profit per order and gross margin all arrive precomputed from SQL
 * (migration 0052), the same way contribution and gross profit always have.
 * Nothing here adds, divides or multiplies a money field.
 *
 * Cards, icon tiles and the vs-previous-period comparison follow the
 * executive dashboard's own `KpiCard` exactly (owner request, 2026-09-29:
 * "match the color vibe") -- `change` is `pnl_summary_change()`'s own
 * percentage (migration 0061), never computed here.
 */
function HeadlineFigures({
  s,
  change,
  previousLabel,
  hrefs,
}: {
  s: PnlSummaryRow
  change: PnlSummaryChangeRow | null
  previousLabel: string
  hrefs?: Partial<Record<string, string>>
}) {
  const money = (value: string | null | undefined) => formatMoney(value, s.currency)
  const figures = s.figures_status
  const vs = `vs ${previousLabel}`
  /** Undefined (chip hidden) while migration 0061 hasn't run yet; null ("Not compared") once it has but there is no prior period. */
  const pct = (value: number | null | undefined): number | null | undefined => (change ? (value ?? null) : undefined)
  return (
    <div className="grid gap-5">
      <KpiGroup title="Sales">
        <KpiCard
          icon={ShoppingBag}
          label="Gross sales"
          value={money(s.gross_sales)}
          status={figures}
          change={pct(change?.gross_sales_change_pct)}
          changeLabel={vs}
          href={hrefs?.gross}
        />
        <KpiCard
          icon={Receipt}
          label="Net sales"
          value={money(s.net_sales)}
          status={figures}
          change={pct(change?.net_sales_change_pct)}
          changeLabel={vs}
          note="After refunds and seller-funded discounts"
        />
        <KpiCard
          icon={Package}
          label="Orders"
          value={formatNumber(s.orders)}
          status={figures}
          change={pct(change?.orders_change_pct)}
          changeLabel={vs}
          note="Distinct orders behind the sales lines"
        />
        <KpiCard
          icon={Calculator}
          label="Average order value"
          value={s.average_order_value === null ? "—" : money(s.average_order_value)}
          status={figures}
          change={pct(change?.average_order_value_change_pct)}
          changeLabel={vs}
          note="Net sales divided by orders"
        />
      </KpiGroup>

      <KpiGroup title="Marketplace costs">
        <KpiCard
          icon={CreditCard}
          label="Marketplace fees"
          value={money(s.marketplace_fees)}
          status={figures}
          change={pct(change?.marketplace_fees_change_pct)}
          changeLabel={vs}
          risingIsGood={false}
          href={hrefs?.fees}
        />
        <KpiCard
          icon={Truck}
          label="Fulfillment & Logistics"
          value={money(s.fulfillment)}
          status={figures}
          change={pct(change?.fulfillment_change_pct)}
          changeLabel={vs}
          risingIsGood={false}
          href={hrefs?.fulfillment}
        />
        <KpiCard
          icon={Megaphone}
          label="Advertising"
          value={money(s.advertising)}
          status={figures}
          change={pct(change?.advertising_change_pct)}
          changeLabel={vs}
          risingIsGood={false}
          href={hrefs?.advertising}
        />
        <KpiCard
          icon={PiggyBank}
          label="Contribution"
          value={s.contribution === null ? "Incomplete" : money(s.contribution)}
          status={s.contribution_status}
          change={pct(change?.contribution_change_pct)}
          changeLabel={vs}
          href={hrefs?.profit}
          note={contributionNote(s)}
        />
      </KpiGroup>

      <KpiGroup title="Profitability">
        <KpiCard
          icon={Boxes}
          label="Cost of goods sold"
          value={s.gross_profit === null ? "Incomplete" : money(s.cogs)}
          status={s.gross_profit_status}
          change={pct(change?.cogs_change_pct)}
          changeLabel={vs}
          risingIsGood={false}
          note={`${formatNumber(s.units_sold, 4)} units sold${s.gross_profit === null ? `; costed so far: ${money(s.cogs)} — not final` : ""}`}
          href={hrefs?.products}
        />
        <KpiCard
          icon={TrendingUp}
          label="Gross profit"
          value={s.gross_profit === null ? "Incomplete" : money(s.gross_profit)}
          status={s.gross_profit_status}
          change={pct(change?.gross_profit_change_pct)}
          changeLabel={vs}
          href={hrefs?.products}
          note={
            s.gross_profit === null
              ? `From what is known so far: ${money(s.gross_profit_before_open_items)} — not final`
              : "Contribution minus cost of goods sold"
          }
        />
        <KpiCard
          icon={Percent}
          label="Gross margin"
          value={s.gross_margin_pct === null ? "Incomplete" : formatPercent(s.gross_margin_pct)}
          status={s.gross_profit_status}
          change={pct(change?.gross_margin_pct_change_pct)}
          changeLabel={vs}
          note="Gross profit as a share of net sales"
        />
        <KpiCard
          icon={Coins}
          label="Profit per order"
          value={s.profit_per_order === null ? "Incomplete" : money(s.profit_per_order)}
          status={s.gross_profit_status}
          change={pct(change?.profit_per_order_change_pct)}
          changeLabel={vs}
          note="Gross profit divided by orders"
        />
      </KpiGroup>
    </div>
  )
}

function KpiGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </section>
  )
}

const STATEMENT_ROWS: { label: string; value: (s: PnlSummaryRow) => string | null; group?: string; total?: boolean }[] = [
  { label: "Gross sales", value: (s) => s.gross_sales, group: "GROSS_SALES" },
  { label: "Sales refunds and returns", value: (s) => s.sales_refunds, group: "SALES_REFUNDS" },
  { label: "Seller-funded discounts", value: (s) => s.seller_discounts, group: "SELLER_DISCOUNTS" },
  { label: "Net sales", value: (s) => s.net_sales, total: true },
  { label: "Other income", value: (s) => s.other_income, group: "OTHER_INCOME" },
  { label: "Marketplace fees", value: (s) => s.marketplace_fees, group: "MARKETPLACE_FEES" },
  { label: "Fulfillment & Logistics", value: (s) => s.fulfillment, group: "FULFILLMENT" },
  { label: "Advertising", value: (s) => s.advertising, group: "ADVERTISING" },
  { label: "Other marketplace costs", value: (s) => s.other_marketplace_costs, group: "OTHER_MARKETPLACE_COSTS" },
  { label: "Non-recoverable VAT on fees", value: (s) => s.non_recoverable_vat },
]

function GrossProfitRows({
  columns,
  href,
}: {
  columns: PnlSummaryRow[]
  href?: string
}) {
  const cell = (s: PnlSummaryRow, value: string) =>
    s.gross_profit === null ? (
      <span className="inline-flex items-center gap-1 font-sans text-xs text-warning-strong">
        <CircleAlert className="size-3.5" aria-hidden />
        Incomplete
      </span>
    ) : (
      <>{formatMoney(value, s.currency)}</>
    )
  const link = href ? (
    <TableCell className="w-28 text-right">
      <Link href={href} className="text-xs font-medium underline-offset-4 hover:underline">
        Products
      </Link>
    </TableCell>
  ) : null
  return (
    <>
      <TableRow>
        <TableCell className="text-sm">Cost of goods sold</TableCell>
        {columns.map((s, index) => (
          <TableCell key={`cogs-${index}`} className="text-right font-mono text-sm tabular-nums">
            {cell(s, s.cogs)}
          </TableCell>
        ))}
        {link}
      </TableRow>
      <TableRow className="bg-muted/40">
        <TableCell className="text-sm font-semibold">
          Gross profit
          <span className="block text-[11px] font-normal text-muted-foreground">Before operating expenses</span>
        </TableCell>
        {columns.map((s, index) => (
          <TableCell key={`gp-${index}`} className="text-right font-mono text-sm font-semibold tabular-nums">
            {cell(s, s.gross_profit ?? "")}
          </TableCell>
        ))}
        {link}
      </TableRow>
    </>
  )
}

function ContributionCell({ s }: { s: PnlSummaryRow }) {
  return s.contribution === null ? (
    <span className="inline-flex items-center gap-1 font-sans text-xs text-warning-strong">
      <CircleAlert className="size-3.5" aria-hidden />
      Incomplete
    </span>
  ) : (
    <>{formatMoney(s.contribution, s.currency)}</>
  )
}

/* ---- one account ------------------------------------------------------------- */

function MonthView({
  summary: s,
  data,
  account,
  month,
  period,
  isOwner,
}: {
  summary: PnlSummaryRow
  data: LedgerMonthData
  account: LedgerAccount
  month: LedgerMonth
  period: PnlPeriod
  isOwner: boolean
}) {
  const money = (value: string | null | undefined) => formatMoney(value, s.currency)

  /*
   * Drilling into "the lines behind this figure" only makes sense when the
   * period is one calendar month -- /ledger/lines reads a single month key.
   * This Month, Last Month and Custom Range always resolve to one month
   * (pnl-period.ts); only This Quarter and This Year do not, and for those
   * `lines()` returns undefined and the "Lines" links simply do not show.
   * Nothing about the P&L figures themselves changes either way.
   */
  const singleMonthKey = isSingleMonthPeriod(period) ? monthKeyOf(period.from) : null
  const lines = (params: Record<string, string | null | undefined>): string | undefined =>
    singleMonthKey ? ledgerHref("/ledger/lines", { account: account.id, month: singleMonthKey, ...params }) : undefined
  const productsHref = ledgerHref("/ledger/products", { account: account.id, month: month.key })
  const profitHref = lines({ view: "profit" })
  const vatHref = lines({ category: "INPUT_VAT" })

  const breakdownRows: BreakdownRow[] = data.breakdown.map((row) => ({
    ...row,
    href:
      row.classification_status === "UNKNOWN"
        ? lines({ view: "unknown", key: row.match_key })
        : lines({ category: row.category, subcategory: row.subcategory }),
  }))

  return (
    <div className="grid gap-6">
      <OpenItems s={s} period={period} isOwner={isOwner} reviewHref={lines({ view: "review" })} />

      <HeadlineFigures
        s={s}
        change={data.change}
        previousLabel={previousPeriodLabel(period)}
        hrefs={{
          gross: lines({ group: "GROSS_SALES" }),
          fees: lines({ group: "MARKETPLACE_FEES" }),
          fulfillment: lines({ group: "FULFILLMENT" }),
          advertising: lines({ group: "ADVERTISING" }),
          profit: profitHref,
          products: productsHref,
        }}
      />

      {/* ---- profit waterfall ---------------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Profit waterfall, {period.label}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gross sales down to gross profit, the same steps as the statement below. These are the P&amp;L
            engine&apos;s own figures, drawn as bars -- nothing here is calculated again.
          </p>
        </div>
        <WaterfallChart steps={data.waterfall} currency={s.currency} />
      </section>

      <Tabs defaultValue="pnl">
        <TabsList>
          <TabsTrigger value="pnl">P&amp;L</TabsTrigger>
          <TabsTrigger value="settlements">Settlements</TabsTrigger>
          <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
        </TabsList>

        {/* ---- P&L: the statement and VAT treatment -------------------- */}
        <TabsContent value="pnl" className="mt-4 grid gap-6">
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold">{period.label}, line by line</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Amounts as the marketplace reported them, signed from your side: money in is positive,
                fees and refunds are negative. This is the business-performance report -- settlement
                payouts are on their own tab and never feed into it.
              </p>
            </div>
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableBody>
                  {STATEMENT_ROWS.filter(
                    (row) => row.label !== "Non-recoverable VAT on fees" || s.input_vat_treatment === "NON_RECOVERABLE"
                  ).map((row) => {
                    const href = row.group
                      ? lines({ group: row.group })
                      : row.total
                        ? undefined
                        : vatHref
                    return (
                      <TableRow key={row.label} className={row.total ? "bg-muted/40" : undefined}>
                        <TableCell className={row.total ? "text-sm font-semibold" : "text-sm"}>{row.label}</TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">{money(row.value(s))}</TableCell>
                        <TableCell className="w-28 text-right">
                          {href && (
                            <Link href={href} className="text-xs font-medium underline-offset-4 hover:underline">
                              Lines
                            </Link>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  <TableRow className="bg-muted/40">
                    <TableCell className="text-sm font-semibold">
                      Contribution
                      <span className="block text-[11px] font-normal text-muted-foreground">
                        Before product costs and operating expenses
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold tabular-nums">
                      <ContributionCell s={s} />
                    </TableCell>
                    <TableCell className="w-28 text-right">
                      {profitHref && (
                        <Link href={profitHref} className="text-xs font-medium underline-offset-4 hover:underline">
                          Lines
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                  <GrossProfitRows columns={[s]} href={productsHref} />
                </TableBody>
              </Table>
            </div>
          </section>

          {/* ---- VAT Treatment -------------------------------------- */}
          <section className="rounded-xl border border-border bg-card px-5 py-4">
            <h2 className="text-sm font-semibold">VAT Treatment</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              VAT on fees for this account:{" "}
              <span className="font-medium text-foreground">
                {INPUT_VAT_TREATMENT_LABEL[s.input_vat_treatment] ?? s.input_vat_treatment}
              </span>
              . Recoverable VAT stays on the tax side; non-recoverable VAT is shown above as a cost.
            </p>
            <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <TaxFigure label="Input VAT on fees, recoverable" value={money(s.input_vat_recoverable)} />
              <TaxFigure label="Input VAT on fees, setting unknown" value={money(s.input_vat_unresolved)} />
              <TaxFigure label="Output VAT on sales" value={money(s.output_vat)} />
              <TaxFigure label="Non-recoverable VAT on fees" value={money(s.non_recoverable_vat)} />
            </dl>
            <p className="mt-3 max-w-prose-comfortable text-xs text-muted-foreground">
              Output VAT identified from this account&apos;s marketplace statement being zero does not mean
              VAT payable is zero -- it only means no output VAT line was recognised in this report. VAT
              payable is worked out by your accountant from the full VAT return, never assumed here.
            </p>
            {vatHref && (
              <Link href={vatHref} className="mt-3 inline-block text-xs font-medium underline-offset-4 hover:underline">
                See the VAT lines
              </Link>
            )}
          </section>
        </TabsContent>

        {/* ---- Settlements: what the marketplace reported and paid ----- */}
        <TabsContent value="settlements" className="mt-4">
          <SettlementsSection payouts={data.payouts} money={money} period={period} />
        </TabsContent>

        {/* ---- Reconciliation: reported vs calculated vs bank ---------- */}
        <TabsContent value="reconciliation" className="mt-4">
          <ReconciliationSection payouts={data.payouts} money={money} />
        </TabsContent>

        {/* ---- Transactions: every line, classified -------------------- */}
        <TabsContent value="transactions" className="mt-4">
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold">Transaction Classification</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Each marketplace code is classified automatically into the same universal categories for
                every marketplace. Nothing is left out: lines BizMind does not recognise are listed with
                their amount.
              </p>
            </div>
            <TransactionClassification rows={breakdownRows} currency={s.currency} />
          </section>
        </TabsContent>
      </Tabs>

      {data.quality.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {formatNumber(data.quality.length)} data quality item{data.quality.length === 1 ? "" : "s"} for this
          account and month.{" "}
          <Link href="/ledger/quality" className="font-medium text-foreground underline underline-offset-4">
            Open data quality
          </Link>
        </p>
      )}
    </div>
  )
}

/**
 * "What the marketplace reported" -- one shape for every marketplace's
 * payout (migration 0039/0056): a formal settlement total (Amazon) or a
 * payment the marketplace reports sending directly (noon), read from
 * `expected_payouts()` -- the same reader Payouts and cashflow already uses,
 * so a noon account shows something real here too, not an empty settlement
 * table. Cash movement, kept apart from the P&L above (item 14): this tab
 * never feeds a profit figure and profit never feeds this tab.
 */
function SettlementsSection({
  payouts,
  money,
  period,
}: {
  payouts: ExpectedPayoutRow[]
  money: (value: string | null | undefined) => string
  period: PnlPeriod
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">Marketplace settlements &amp; payouts</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each settlement or payment touching {period.label}, with what the marketplace stated beside what
          BizMind calculated from its own lines. Amazon reports a settlement total; noon reports a payment
          directly, with no settlement to check it against. Either way, this is what the marketplace says
          it sent -- not what reached your bank.
        </p>
      </div>
      {payouts.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">
          No settlement or payout report covers this period yet.
        </p>
      ) : (
        <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Settlement Period</TableHead>
                <TableHead className="text-right">Marketplace Reported</TableHead>
                <TableHead className="text-right">BizMind Calculated</TableHead>
                <TableHead className="text-right">Bank Received</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payouts.map((p) => (
                <TableRow key={p.payout_key}>
                  <TableCell className="text-xs">
                    {p.source_file_id ? (
                      <Link href={`/imports/${p.source_file_id}`} className="font-mono underline-offset-4 hover:underline">
                        {p.reference ?? "—"}
                      </Link>
                    ) : (
                      <span className="font-mono">{p.reference ?? "—"}</span>
                    )}
                    {p.expected_date && (
                      <span className="block text-[11px] text-muted-foreground">{formatLedgerDay(p.expected_date)}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{PAYOUT_SOURCE_LABEL[p.source]}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.period_start ? `${formatLedgerDay(p.period_start)} – ${formatLedgerDay(p.period_end)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">{money(p.expected_amount)}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {p.settlement_lines_total === null ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      money(p.settlement_lines_total)
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {BANK_RECEIPT_STATUS_LABEL[p.bank_receipt_status]}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {p.difference === null ? <span className="text-xs text-muted-foreground">—</span> : money(p.difference)}
                  </TableCell>
                  <TableCell>
                    <PayoutStatusCell status={p.marketplace_status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

/**
 * Reconciliation: the same payout rows, read the other way -- did what the
 * marketplace reported match what BizMind calculated, and (once a bank
 * source exists) what actually reached the bank. No new figures: the exact
 * same `expected_payouts()` rows as the Settlements tab.
 */
function ReconciliationSection({
  payouts,
  money,
}: {
  payouts: ExpectedPayoutRow[]
  money: (value: string | null | undefined) => string
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">Reconciliation</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Verifies each settlement adds up on its own terms: the marketplace&apos;s stated total against the
          sum of its own lines. A noon payment has no settlement total to check, so it is simply reported --
          not in doubt, not adding up, just stated. Bank Received stays &quot;Not connected&quot; until a real
          bank feed exists -- BizMind never invents a bank transaction.
        </p>
      </div>
      {payouts.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">Nothing to reconcile for this period yet.</p>
      ) : (
        <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Marketplace Reported</TableHead>
                <TableHead className="text-right">BizMind Calculated</TableHead>
                <TableHead className="text-right">Bank Received</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payouts.map((p) => (
                <TableRow key={p.payout_key}>
                  <TableCell className="font-mono text-xs">{p.reference ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">{money(p.expected_amount)}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {p.settlement_lines_total === null ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      money(p.settlement_lines_total)
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {BANK_RECEIPT_STATUS_LABEL[p.bank_receipt_status]}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {p.difference === null ? <span className="text-xs text-muted-foreground">—</span> : money(p.difference)}
                  </TableCell>
                  <TableCell>
                    <PayoutStatusCell status={p.marketplace_status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

function PayoutStatusCell({ status }: { status: ExpectedPayoutRow["marketplace_status"] }) {
  const label = PAYOUT_STATUS_LABEL[status]
  const help = PAYOUT_STATUS_HELP[status]
  if (status === "ADDS_UP") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success-strong" title={help}>
        <CircleCheck className="size-3.5" aria-hidden />
        {label}
      </span>
    )
  }
  if (status === "DOES_NOT_ADD_UP") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-danger-strong" title={help}>
        <CircleAlert className="size-3.5" aria-hidden />
        {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={help}>
      {label}
    </span>
  )
}

/* ---- every account in one currency ------------------------------------------ */

function CombinedView({
  data,
  total,
  month,
  period,
  isOwner,
}: {
  data: CurrencyMonthData
  total: PnlSummaryRow
  month: LedgerMonth
  period: PnlPeriod
  isOwner: boolean
}) {
  const money = (value: string | null | undefined) => formatMoney(value, total.currency)
  const columns = [...data.perAccount, total]

  return (
    <div className="grid gap-6">
      <OpenItems s={total} period={period} isOwner={isOwner} />
      <HeadlineFigures
        s={total}
        change={data.change}
        previousLabel={previousPeriodLabel(period)}
        hrefs={{ products: ledgerHref("/ledger/products", { account: `${ALL_PREFIX}${total.currency}`, month: month.key }) }}
      />

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Profit waterfall, {period.label}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gross sales down to gross profit for every {total.currency} account added up. The P&amp;L
            engine&apos;s own figures, drawn as bars.
          </p>
        </div>
        <WaterfallChart steps={data.waterfall} currency={total.currency} />
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">
            {period.label}: {formatNumber(total.accounts)} {total.currency} accounts side by side
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each account as the engine worked it out, and their total. Open an account to see its lines.
          </p>
        </div>
        <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Figure</TableHead>
                {data.perAccount.map((row) => (
                  <TableHead key={row.marketplace_account_id} className="text-right">
                    <Link
                      href={ledgerHref("/ledger", { account: row.marketplace_account_id, month: month.key })}
                      className="underline-offset-4 hover:underline"
                    >
                      {row.account_label}
                    </Link>
                    <span className="block text-[11px] font-normal text-muted-foreground">{row.marketplace_code}</span>
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {STATEMENT_ROWS.map((row) => (
                <TableRow key={row.label} className={row.total ? "bg-muted/40" : undefined}>
                  <TableCell className={row.total ? "text-sm font-semibold" : "text-sm"}>{row.label}</TableCell>
                  {columns.map((column, index) => (
                    <TableCell
                      key={`${row.label}-${column.marketplace_account_id ?? "total"}-${index}`}
                      className="text-right font-mono text-sm tabular-nums"
                    >
                      {money(row.value(column))}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              <TableRow className="bg-muted/40">
                <TableCell className="text-sm font-semibold">Contribution</TableCell>
                {columns.map((column, index) => (
                  <TableCell
                    key={`contribution-${column.marketplace_account_id ?? "total"}-${index}`}
                    className="text-right font-mono text-sm font-semibold tabular-nums"
                  >
                    <ContributionCell s={column} />
                  </TableCell>
                ))}
              </TableRow>
              <GrossProfitRows columns={columns} />
              <TableRow>
                <TableCell className="text-xs text-muted-foreground">Contribution status</TableCell>
                {columns.map((column, index) => (
                  <TableCell key={`status-${column.marketplace_account_id ?? "total"}-${index}`} className="text-right">
                    <StatusLabel status={column.contribution_status} />
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}

/* ---- net profit, for a whole currency --------------------------------------- */

const NET_REASON: Record<string, string> = {
  UNKNOWN_LINES: "some marketplace lines are not recognised",
  VAT_TREATMENT_UNKNOWN: "VAT on marketplace fees has no setting",
  FEE_VAT_NOT_SEPARATED: "marketplace fees still include VAT",
  ROW_ERRORS: "some marketplace rows could not be read",
  SKU_NOT_MAPPED: "some SKUs are not matched to a product",
  COST_MISSING: "some products have no cost for the sale date",
  NO_MARKETPLACE_DATA: "there are no marketplace figures",
  EXPENSES_UNCLASSIFIED: "some expense categories are not placed yet",
}

function NetProfitSection({ net, month }: { net: NetProfitRow; month: LedgerMonth }) {
  const money = (value: string | null | undefined) => formatMoney(value, net.currency)
  const final = net.net_profit !== null
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">
            Net profit, {month.label} ({net.currency})
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gross profit from {formatNumber(net.accounts)} {net.currency} account{net.accounts === 1 ? "" : "s"}, less the
            running costs of the business.
          </p>
        </div>
        <StatusLabel status={net.net_profit_status} />
      </div>
      <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5">
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="text-sm">Gross profit</TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">
                {net.gross_profit === null ? "Incomplete" : money(net.gross_profit)}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-sm">Operating expenses</TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">{money(net.operating_expenses)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="text-sm">Advertising outside the marketplaces</TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">{money(net.external_advertising)}</TableCell>
            </TableRow>
            <TableRow className="bg-muted/40">
              <TableCell className="text-sm font-semibold">Net profit</TableCell>
              <TableCell className="text-right font-mono text-sm font-semibold tabular-nums">
                {final ? (
                  money(net.net_profit)
                ) : (
                  <span className="inline-flex items-center gap-1 font-sans text-xs text-warning-strong">
                    <CircleAlert className="size-3.5" aria-hidden />
                    Incomplete
                  </span>
                )}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        {final
          ? "Expenses are classified automatically from your expense sheets. "
          : `Not final because ${net.net_profit_reasons.map((r) => NET_REASON[r] ?? r).join("; ")}. From what is known so far: ${money(net.net_profit_before_open_items)} — not final. `}
        <Link href={ledgerHref("/ledger/expenses", { month: month.key })} className="font-medium text-foreground underline underline-offset-4">
          Operating expenses
        </Link>
      </p>
    </section>
  )
}

function TaxFigure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function NoLines({ month }: { month: LedgerMonth }) {
  return (
    <EmptyState
      title={`No lines were posted in ${month.label}`}
      body="Choose another month, or upload the report that covers this one."
      href="/imports/settlement"
      action="Upload a report"
    />
  )
}

function EmptyState({ title, body, href, action }: { title: string; body: string; href: string; action: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center">
      <p className="font-heading text-lg font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      <Button asChild size="sm" variant="outline" className="mt-4 rounded-4xl">
        <Link href={href}>{action}</Link>
      </Button>
    </div>
  )
}
