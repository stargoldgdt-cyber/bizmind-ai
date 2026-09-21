import Link from "next/link"
import {
  ArrowRight,
  Bell,
  CircleAlert,
  CircleCheck,
  Info,
  Landmark,
  Lightbulb,
  ShieldCheck,
  TrendingUp,
} from "lucide-react"

import { cn } from "cn"
import { ChangeChip } from "@/features/overview/components/kpi-card"
import { StatusLabel } from "@/features/ledger/components/status-label"
import type { AccountRow, CostRow, OverviewRow, PayoutRow, ProductRow } from "@/features/overview/queries"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { formatLedgerDay } from "@/services/ledger/display"
import type { Finding, Tone } from "@/services/overview/findings"
import { BANK_RECEIPT_STATUS_LABEL, PAYOUT_STATUS_LABEL } from "@/services/payouts/labels"
import type { Alert } from "@/types/database"

/**
 * The home dashboard's sections (server components).
 *
 * Every figure, share, change and bar length arrives from SQL (0043 and the
 * ledger readers). These components choose words, order and emphasis only.
 * An expected payout is never called received; the bank column always reads
 * from its own status, which is "Not connected" until a bank source exists.
 */

export function Card({
  title,
  description,
  icon: Icon,
  aside,
  children,
  className,
}: {
  title: string
  description?: string
  icon?: React.ComponentType<{ className?: string }>
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col overflow-hidden rounded-xl border border-border bg-card", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 font-heading text-base font-semibold">
            {Icon && <Icon className="size-4 text-primary" aria-hidden />}
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

/* ---- the one-line state of the month ---------------------------------------- */

export function StatusRibbon({ o, monthLabel }: { o: OverviewRow; monthLabel: string }) {
  const final = o.contribution_status === "FINAL"
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-2.5 text-xs",
        final ? "border-success/35 bg-success-subtle" : "border-warning/40 bg-warning-subtle"
      )}
    >
      <span className={cn("inline-flex items-center gap-1.5 font-semibold", final ? "text-success-strong" : "text-warning-strong")}>
        {final ? <CircleCheck className="size-4" aria-hidden /> : <CircleAlert className="size-4" aria-hidden />}
        {final ? `${monthLabel}: figures are final` : `${monthLabel}: some figures are not final yet`}
      </span>
      <span className="text-muted-foreground">
        {o.scope_label} · {formatNumber(o.accounts)} account{o.accounts === 1 ? "" : "s"} · {formatNumber(o.lines)} lines
      </span>
      {(o.unknown_lines ?? 0) > 0 && (
        <span className="inline-flex items-center gap-1 text-warning-strong">
          <CircleAlert className="size-3.5" aria-hidden />
          {formatNumber(o.unknown_lines)} not recognised
        </span>
      )}
      <span className="ml-auto rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
        {o.currency} · accrual, by posted date
      </span>
    </div>
  )
}

/* ---- open alerts --------------------------------------------------------------- */

const SEVERITY_WORD: Record<Alert["severity"], string> = {
  INFO: "Info",
  WARNING: "Warning",
  CRITICAL: "Critical",
}

export function AlertStrip({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return null
  return (
    <section aria-label="Open alerts" className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-sm font-semibold">
          <Bell className="size-4 text-primary" aria-hidden />
          {formatNumber(alerts.length)} open alert{alerts.length === 1 ? "" : "s"}
        </p>
        <Link href="/alerts" className="text-xs font-medium underline-offset-4 hover:underline">
          All alerts
        </Link>
      </div>
      <ul className="mt-2 grid gap-2 md:grid-cols-3">
        {alerts.slice(0, 3).map((a) => (
          <li key={a.id} className="rounded-lg border border-border px-3 py-2">
            <p
              className={cn(
                "inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide",
                a.severity === "INFO" ? "text-info-strong" : a.severity === "WARNING" ? "text-warning-strong" : "text-danger-strong"
              )}
            >
              {a.severity === "INFO" ? <Info className="size-3.5" aria-hidden /> : <CircleAlert className="size-3.5" aria-hidden />}
              {SEVERITY_WORD[a.severity]}
            </p>
            <p className="mt-0.5 line-clamp-2 text-sm font-medium">{a.title}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ---- what to fix -------------------------------------------------------------- */

const TONE: Record<Tone, { icon: React.ComponentType<{ className?: string }>; text: string; border: string }> = {
  attention: { icon: CircleAlert, text: "text-warning-strong", border: "border-warning/40" },
  watch: { icon: TrendingUp, text: "text-warning-strong", border: "border-border" },
  info: { icon: Info, text: "text-info-strong", border: "border-border" },
  good: { icon: CircleCheck, text: "text-success-strong", border: "border-border" },
}

export function NeedsAttention({ items }: { items: Finding[] }) {
  if (items.length === 0) return null
  return (
    <Card
      title="What needs your attention"
      description="Each one keeps a figure from being final. Fix it once and the figures update."
      icon={CircleAlert}
    >
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const tone = TONE[item.tone]
          const Icon = tone.icon
          return (
            <li key={item.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-3">
                <Icon className={cn("mt-0.5 size-4 shrink-0", tone.text)} aria-hidden />
                <div>
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.body}</p>
                </div>
              </div>
              <Link
                href={item.href}
                className="inline-flex shrink-0 items-center gap-1 self-start rounded-full border border-border px-3 py-1 text-xs font-medium hover:border-primary/40 hover:text-primary sm:self-center"
              >
                {item.action}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ---- where the marketplace costs go ------------------------------------------ */

export function CostBreakdown({ rows, o, linesHref }: { rows: CostRow[]; o: OverviewRow; linesHref: string }) {
  const money = (v: string | null | undefined) => formatMoney(v, o.currency)
  return (
    <Card
      title="Where your marketplace costs go"
      description="What the marketplaces kept this month, largest first."
      aside={
        o.costs_pct_of_net_sales !== null ? (
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium tabular-nums">
            {formatPercent(o.costs_pct_of_net_sales)} of net sales
          </span>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">No marketplace costs this month.</p>
      ) : (
        <ul className="grid gap-4 px-5 py-4">
          {rows.map((row) => (
            <li key={row.category}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>{row.label}</span>
                <span className="font-mono tabular-nums">
                  {money(row.total)}
                  {row.pct_of_net_sales !== null && (
                    <span className="ml-1.5 text-xs text-muted-foreground">({formatPercent(row.pct_of_net_sales)})</span>
                  )}
                </span>
              </div>
              <div className="mt-1.5 h-2 rounded-full bg-muted" aria-hidden>
                <div className="h-2 rounded-full bg-chart-3" style={{ width: `${Math.max(row.bar / 10, 1)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto flex items-center justify-between border-t border-border bg-muted/40 px-5 py-3 text-sm">
        <span className="font-medium">Total marketplace costs</span>
        <span className="font-mono font-semibold tabular-nums">{money(o.marketplace_costs)}</span>
      </div>
      <Link href={linesHref} className="border-t border-border px-5 py-2.5 text-xs font-medium underline-offset-4 hover:underline">
        See every line behind these costs
      </Link>
    </Card>
  )
}

/* ---- against last month ------------------------------------------------------- */

export function ChangeAnalysis({ o, previousLabel }: { o: OverviewRow; previousLabel: string }) {
  const rows: { label: string; change: number | null; risingIsGood: boolean; note?: string }[] = [
    { label: "Gross sales", change: o.gross_sales_change_pct, risingIsGood: true },
    { label: "Net sales", change: o.net_sales_change_pct, risingIsGood: true },
    { label: "Marketplace costs", change: o.marketplace_costs_change_pct, risingIsGood: false },
    {
      label: "Contribution",
      change: o.contribution_change_pct,
      risingIsGood: true,
      note: o.contribution_change_pct === null && o.prev_has_marketplace_data ? "Compared only when both months are final" : undefined,
    },
    { label: "Gross profit", change: o.gross_profit_change_pct, risingIsGood: true },
    ...(o.net_available ? [{ label: "Net profit", change: o.net_profit_change_pct, risingIsGood: true }] : []),
  ]
  return (
    <Card
      title={`What changed since ${previousLabel}`}
      description={
        o.prev_has_marketplace_data
          ? "Each figure against the same figure last month. A figure that is not final in either month is not compared."
          : `There are no marketplace figures for ${previousLabel}, so nothing is compared yet.`
      }
    >
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-3 px-5 py-3">
            <div>
              <p className="text-sm">{row.label}</p>
              {row.note && <p className="text-[11px] text-muted-foreground">{row.note}</p>}
            </div>
            <ChangeChip change={row.change} label="" risingIsGood={row.risingIsGood} />
          </li>
        ))}
      </ul>
      {o.advertising_pct_of_net_sales !== null && (
        <p className="mt-auto border-t border-border bg-muted/40 px-5 py-3 text-xs text-muted-foreground">
          Marketplace advertising this month: {formatMoney(o.advertising, o.currency)}, {formatPercent(o.advertising_pct_of_net_sales)} of net sales.
        </p>
      )}
    </Card>
  )
}

/* ---- each marketplace account ------------------------------------------------- */

export function AccountsTable({
  rows,
  currency,
  selected,
  hrefFor,
}: {
  rows: AccountRow[]
  currency: string
  selected: string | null
  hrefFor: (accountId: string) => string
}) {
  const money = (v: string | null | undefined) => formatMoney(v, currency)
  return (
    <Card
      title="Marketplace performance"
      description={`Every ${currency} account this month, as each marketplace reported it. Open one to see it alone.`}
      icon={TrendingUp}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] whitespace-nowrap text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-2 font-semibold">Account</th>
              <th className="px-3 py-2 text-right font-semibold">Net sales</th>
              <th className="px-3 py-2 text-right font-semibold">Marketplace costs</th>
              <th className="px-3 py-2 text-right font-semibold">Advertising</th>
              <th className="px-3 py-2 text-right font-semibold">Contribution</th>
              <th className="px-3 py-2 text-right font-semibold">Margin</th>
              <th className="px-3 py-2 text-right font-semibold">Share of sales</th>
              <th className="px-5 py-2 text-right font-semibold">Expected payouts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr
                key={row.marketplace_account_id}
                className={cn(row.marketplace_account_id === selected && "bg-primary/5")}
              >
                <td className="px-5 py-3">
                  <Link href={hrefFor(row.marketplace_account_id)} className="font-medium underline-offset-4 hover:underline">
                    {row.account_label}
                  </Link>
                  <span className="block text-[11px] text-muted-foreground">
                    {row.marketplace_code}
                    {row.open_quality_items > 0 && (
                      <span className="ml-2 text-warning-strong">· {formatNumber(row.open_quality_items)} to review</span>
                    )}
                  </span>
                </td>
                {!row.has_lines ? (
                  <td colSpan={7} className="px-3 py-3 text-right text-xs text-muted-foreground">
                    No lines this month
                  </td>
                ) : (
                  <>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{money(row.net_sales)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{money(row.marketplace_costs)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">{money(row.advertising)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {row.contribution === null ? <StatusLabel status="INCOMPLETE" /> : money(row.contribution)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {row.contribution_margin_pct === null ? "—" : formatPercent(row.contribution_margin_pct)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {row.share_of_net_sales_pct === null ? "—" : formatPercent(row.share_of_net_sales_pct)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums">
                      {row.expected_payouts === 0 ? "—" : money(row.expected_inflow)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/* ---- expected payouts (never "received") -------------------------------------- */

export function PayoutsCard({ o, payouts, href }: { o: OverviewRow; payouts: PayoutRow[]; href: string }) {
  const money = (v: string | null | undefined) => formatMoney(v, o.currency)
  return (
    <Card
      title="Expected marketplace payouts"
      description="What the marketplaces' own reports say they will pay. Not money received: no bank is connected."
      icon={Landmark}
    >
      <dl className="grid grid-cols-2 gap-4 border-b border-border px-5 py-4">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Expected inflow</dt>
          <dd className="font-mono text-xl font-semibold tabular-nums">{money(o.expected_inflow)}</dd>
          <dd className="text-xs text-muted-foreground">
            {formatNumber(o.expected_payouts)} payout{o.expected_payouts === 1 ? "" : "s"}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Actual bank receipt</dt>
          <dd className="text-sm font-medium text-muted-foreground">{BANK_RECEIPT_STATUS_LABEL.NOT_CONNECTED}</dd>
          <dd className="text-xs text-muted-foreground">Appears once a bank source is connected</dd>
        </div>
      </dl>
      {payouts.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">No payouts are expected in this month.</p>
      ) : (
        <ul className="divide-y divide-border">
          {payouts.slice(0, 4).map((p) => {
            const doubt = p.marketplace_status === "DOES_NOT_ADD_UP"
            return (
              <li key={p.payout_key} className="flex items-start justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {p.account_label}
                    {p.reference && <span className="ml-2 font-mono text-xs text-muted-foreground">#{p.reference}</span>}
                  </p>
                  <p
                    className={cn(
                      "mt-0.5 inline-flex items-center gap-1 text-xs",
                      doubt ? "text-danger-strong" : p.marketplace_status === "ADDS_UP" ? "text-success-strong" : "text-muted-foreground"
                    )}
                  >
                    {doubt ? <CircleAlert className="size-3.5" aria-hidden /> : <CircleCheck className="size-3.5" aria-hidden />}
                    {PAYOUT_STATUS_LABEL[p.marketplace_status]}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-sm tabular-nums">{money(p.expected_amount)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {p.expected_date ? `Expected ${formatLedgerDay(p.expected_date)}` : "No date reported"}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <Link href={href} className="mt-auto border-t border-border px-5 py-2.5 text-xs font-medium underline-offset-4 hover:underline">
        {payouts.length > 4 ? `All ${formatNumber(payouts.length)} payouts and cashflow` : "Payouts and cashflow"}
      </Link>
    </Card>
  )
}

/* ---- data health ------------------------------------------------------------- */

export function DataHealth({ o, monthKey }: { o: OverviewRow; monthKey: string }) {
  const checks: { ok: boolean; text: string; href: string }[] = [
    {
      ok: (o.unknown_lines ?? 0) === 0,
      text:
        (o.unknown_lines ?? 0) === 0
          ? `All ${formatNumber(o.lines)} lines classified automatically`
          : `${formatNumber(o.unknown_lines)} of ${formatNumber(o.lines)} lines not recognised`,
      href: "/ledger/quality",
    },
    {
      ok: !o.contribution_reasons.includes("VAT_TREATMENT_UNKNOWN") && !o.contribution_reasons.includes("FEE_VAT_NOT_SEPARATED"),
      text: o.contribution_reasons.includes("VAT_TREATMENT_UNKNOWN")
        ? "VAT on marketplace fees has no setting"
        : o.contribution_reasons.includes("FEE_VAT_NOT_SEPARATED")
          ? "Some fees still include VAT BizMind cannot separate"
          : "VAT on fees kept apart from profit",
      href: "/marketplaces",
    },
    {
      ok: o.unmatched_skus === 0,
      text: o.unmatched_skus === 0 ? "Every SKU sold is matched to a product" : `${formatNumber(o.unmatched_skus)} SKUs sold this month need product mapping`,
      href: "/catalog#needs-attention",
    },
    {
      ok: !o.gross_profit_reasons.includes("COST_MISSING"),
      text: o.gross_profit_reasons.includes("COST_MISSING")
        ? "Some products sold have no cost"
        : o.unmatched_skus > 0
          ? "Every matched product has a cost"
          : "Every product sold has a cost",
      href: "/catalog",
    },
    {
      ok: o.payouts_in_doubt === 0,
      text: o.payouts_in_doubt === 0 ? "Settlements add up to their reported totals" : `${formatNumber(o.payouts_in_doubt)} settlements do not add up`,
      href: `/ledger/payouts?month=${monthKey}`,
    },
    {
      ok: o.unplaced_expense_categories === 0,
      text:
        o.unplaced_expense_categories === 0
          ? "Every expense category is placed"
          : `${formatNumber(o.unplaced_expense_categories)} expense categories to place`,
      href: `/ledger/expenses?month=${monthKey}`,
    },
  ]
  const passing = checks.filter((c) => c.ok).length
  return (
    <Card
      title="Data health"
      description="What BizMind checked before showing you these figures."
      icon={ShieldCheck}
      aside={
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium tabular-nums">
          {passing} of {checks.length} checks pass
        </span>
      }
    >
      <ul className="grid gap-1 px-3 py-3">
        {checks.map((c) => (
          <li key={c.text}>
            <Link href={c.href} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/60">
              {c.ok ? (
                <CircleCheck className="size-4 shrink-0 text-success-strong" aria-label="Passes" />
              ) : (
                <CircleAlert className="size-4 shrink-0 text-warning-strong" aria-label="Needs attention" />
              )}
              <span className={cn(!c.ok && "font-medium")}>{c.text}</span>
            </Link>
          </li>
        ))}
      </ul>
      {(o.review_lines ?? 0) > 0 && (
        <p className="mt-auto border-t border-border px-5 py-3 text-xs text-muted-foreground">
          {formatNumber(o.review_lines)} lines are counted with a medium-confidence rule.{" "}
          <Link href="/ledger/quality" className="font-medium text-foreground underline underline-offset-4">
            Check them
          </Link>
        </p>
      )}
    </Card>
  )
}

/* ---- products ----------------------------------------------------------------- */

export function ProductsTable({ rows, currency, href }: { rows: ProductRow[]; currency: string; href: string }) {
  const money = (v: string | null | undefined) => formatMoney(v, currency)
  return (
    <Card
      title="Product profitability"
      description="Your best sellers this month, including SKUs not yet matched to a product. Marketplace-level fees and advertising are not split across products."
      icon={TrendingUp}
    >
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">No product sales this month.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] whitespace-nowrap text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2 font-semibold">Product</th>
                <th className="px-3 py-2 text-right font-semibold">Units</th>
                <th className="px-3 py-2 text-right font-semibold">Net sales</th>
                <th className="px-3 py-2 text-right font-semibold">Product-level costs</th>
                <th className="px-3 py-2 text-right font-semibold">Cost of goods</th>
                <th className="px-3 py-2 text-right font-semibold">Gross profit</th>
                <th className="px-5 py-2 text-right font-semibold">Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((p) => (
                <tr key={`${p.row_kind}-${p.product_id ?? p.raw_sku}-${p.marketplace_code ?? ""}`}>
                  <td className="min-w-52 whitespace-normal px-5 py-3">
                    <span className="font-medium">{p.product_name ?? p.raw_sku}</span>
                    {p.row_kind === "UNMAPPED_SKU" ? (
                      <span className="flex items-center gap-1 text-[11px] text-warning-strong">
                        <CircleAlert className="size-3" aria-hidden />
                        SKU not matched to a product
                      </span>
                    ) : (
                      p.product_category && <span className="block text-[11px] text-muted-foreground">{p.product_category}</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">{formatNumber(p.units_sold, 4)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">{money(p.net_sales)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">{money(p.costs)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">{p.cogs === null ? "—" : money(p.cogs)}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">
                    {p.gross_profit === null ? <StatusLabel status="INCOMPLETE" /> : money(p.gross_profit)}
                  </td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums">
                    {p.gross_margin_percent === null ? "—" : formatPercent(p.gross_margin_percent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link href={href} className="border-t border-border px-5 py-2.5 text-xs font-medium underline-offset-4 hover:underline">
        All products, unmatched SKUs and costs
      </Link>
    </Card>
  )
}

/* ---- plain observations -------------------------------------------------------- */

export function Insights({ items }: { items: Finding[] }) {
  if (items.length === 0) return null
  return (
    <Card
      title="BizMind insights"
      description="Plain observations from this month's verified figures. Each rule says when it appears."
      icon={Lightbulb}
    >
      <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => {
          const tone = TONE[item.tone]
          const Icon = tone.icon
          return (
            <li key={item.id} className={cn("flex flex-col gap-2 rounded-lg border p-4", tone.border)}>
              <p className={cn("inline-flex items-center gap-1.5 text-sm font-semibold", tone.text)}>
                <Icon className="size-4" aria-hidden />
                {item.title}
              </p>
              <p className="text-sm text-muted-foreground">{item.body}</p>
              <Link href={item.href} className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline">
                {item.action}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
