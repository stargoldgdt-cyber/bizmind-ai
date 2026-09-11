import type { Metadata } from "next"

import { AppShell } from "@/components/layout/app-shell"
import { DataQuality } from "@/features/analytics/components/data-quality"
import { PageHeader } from "@/features/analytics/components/page-header"
import { loadAnalyticsPage } from "@/features/analytics/page-context"
import { formatMoney, formatPercent } from "@/lib/format"
import { findComparison, METRICS } from "@/services/analytics"
import type { MetricComparison } from "@/services/analytics"
import { DeltaChip } from "@/features/analytics/components/delta-chip"

export const metadata: Metadata = { title: "Profit" }

/**
 * Profit.
 *
 * The whole path from revenue to what is left, in the order money actually
 * leaves the business. A dashboard shows the headline; this shows the
 * subtraction, because the useful question is not "what is my profit" but
 * "which line took it".
 *
 * NO NEW DEFINITION OF PROFIT. Every row is a metric the analytics engine
 * already computes and already names in `METRICS`. This page performs no
 * arithmetic — not even the subtractions it displays, which arrive as their
 * own computed figures.
 */
export default async function ProfitPage(props: PageProps<"/profit">) {
  const context = await loadAnalyticsPage(await props.searchParams)
  const { analytics, business, period, hasSales } = context
  const { current, comparisons } = analytics
  const currency = business.currency

  const change = (metric: string): number | null => {
    const found: MetricComparison | undefined = findComparison(comparisons, metric)
    const value = found?.percent_change
    return value === null || value === undefined ? null : Number(value)
  }

  /** One line of the statement. `deduction` is styling, not arithmetic. */
  const rows: {
    metric: string
    value: string
    deduction?: boolean
    emphasis?: boolean
  }[] = [
    { metric: "revenue", value: formatMoney(current.revenue, currency) },
    { metric: "cogs", value: formatMoney(current.cogs, currency), deduction: true },
    { metric: "fees", value: formatMoney(current.fees, currency), deduction: true },
    {
      metric: "gross_profit",
      value: formatMoney(current.gross_profit, currency),
      emphasis: true,
    },
    { metric: "gross_margin", value: formatPercent(current.gross_margin) },
    { metric: "expenses", value: formatMoney(current.expenses, currency), deduction: true },
    {
      metric: "net_profit",
      value: formatMoney(current.net_profit, currency),
      emphasis: true,
    },
    { metric: "net_margin", value: formatPercent(current.net_margin) },
  ]

  return (
    <AppShell
      businesses={context.businesses}
      activeBusinessId={business.id}
      userEmail={context.user.email}
      userName={context.userName}
    >
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Profit"
          description="Revenue at the top, what is left at the bottom, and every deduction in between."
          period={period}
          currency={currency}
          basePath="/profit"
        />

        {!hasSales ? (
          <p className="mt-8 rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            No sales in this period, so there is nothing to break down. Try a
            longer range.
          </p>
        ) : (
          <>
            <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Profit and loss for {period.label}
                </caption>
                <tbody>
                  {rows.map((row) => {
                    const definition = METRICS[row.metric]
                    return (
                      <tr
                        key={row.metric}
                        className={`border-b border-border last:border-0 ${
                          row.emphasis ? "bg-muted/40" : ""
                        }`}
                      >
                        <th
                          scope="row"
                          className={`px-5 py-3.5 text-left font-normal ${
                            row.emphasis ? "font-semibold" : ""
                          }`}
                        >
                          {row.deduction && (
                            <span className="mr-1.5 text-muted-foreground" aria-hidden>
                              −
                            </span>
                          )}
                          {definition?.label ?? row.metric}
                          {definition?.definition && (
                            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                              {definition.definition}
                            </span>
                          )}
                        </th>

                        <td className="px-5 py-3.5 text-right">
                          <DeltaChip
                            change={change(row.metric)}
                            higherIsBetter={definition?.higherIsBetter ?? true}
                          />
                        </td>

                        <td
                          className={`px-5 py-3.5 text-right font-mono tabular-nums ${
                            row.emphasis ? "text-base font-semibold" : ""
                          }`}
                        >
                          {row.value}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4">
              <DataQuality current={current} />
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              Every figure is calculated in the database from your own records.
              Cancelled and refunded orders are excluded from revenue.
            </p>
          </>
        )}
      </div>
    </AppShell>
  )
}
