import type { Metadata } from "next"
import Link from "next/link"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { DataQuality } from "@/features/analytics/components/data-quality"
import { PageHeader } from "@/features/analytics/components/page-header"
import { loadAnalyticsPage } from "@/features/analytics/page-context"
import { formatMoney } from "@/lib/format"

export const metadata: Metadata = { title: "Data quality" }

/**
 * Data quality.
 *
 * WHY THIS IS A PAGE AND NOT A WARNING BANNER
 * -------------------------------------------
 * Every other tool an owner has used reported a margin without saying how much
 * of it was guesswork. BizMind knows exactly which order lines have no cost and
 * which orders have no fee, so it can state the gap and which way it moves the
 * figure.
 *
 * That makes completeness a first-class fact about the business, on the same
 * footing as revenue — not a footnote under it.
 *
 * Every number here comes from the analytics service. Coverage figures are
 * computed in SQL (migration 0010 added the gap columns precisely so nothing
 * downstream would have to derive them).
 */
export default async function DataQualityPage(props: PageProps<"/data-quality">) {
  const context = await loadAnalyticsPage(await props.searchParams)
  const { analytics, business, period, hasSales } = context
  const { current, reconciliation } = analytics
  const currency = business.currency

  return (
    <AppShell
      businesses={context.businesses}
      activeBusinessId={business.id}
      userEmail={context.user.email}
      userName={context.userName}
    >
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Data quality"
          description="How much of what BizMind tells you can be relied on, and what would need to change."
          period={period}
          currency={currency}
          basePath="/data-quality"
        />

        {!hasSales ? (
          <p className="mt-8 rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            Nothing was recorded in this period, so there is nothing to assess.
          </p>
        ) : (
          <>
            <div className="mt-8">
              <DataQuality current={current} />
            </div>

            {/* Coverage as figures, since this is the page where they belong. */}
            <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
              <Coverage
                label="Cost coverage"
                value={current.cost_coverage}
                detail={`${current.items_with_cost} of ${current.items_total} order lines have a cost`}
              />
              <Coverage
                label="Fee coverage"
                value={current.fee_coverage}
                detail={`${current.orders_count - current.orders_fees_unknown} of ${current.orders_count} orders have a fee`}
              />
              <Coverage
                label="Channel attribution"
                value={null}
                detail={
                  current.orders_without_channel === 0
                    ? "Every order is attributed to a channel"
                    : `${current.orders_without_channel} orders have no channel`
                }
              />
            </div>

            {/* Reconciliation: where the model's own totals do not line up. */}
            <div className="mt-4 rounded-xl border border-border bg-card px-5 py-4">
              <h2 className="text-sm font-semibold">Do the totals agree?</h2>

              <ul className="mt-3 space-y-2.5 text-sm">
                <li className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-muted-foreground">
                    Channel revenue against total revenue
                  </span>
                  <span
                    className={
                      Number(reconciliation.channel_difference) === 0
                        ? "text-success-strong"
                        : "font-medium text-danger-strong"
                    }
                  >
                    {Number(reconciliation.channel_difference) === 0
                      ? "Agrees exactly"
                      : `Differs by ${formatMoney(reconciliation.channel_difference, currency)} — please report this`}
                  </span>
                </li>

                <li className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-muted-foreground">
                    Product lines against order totals
                  </span>
                  <span className="text-right">
                    {Number(reconciliation.order_line_gap) === 0 ? (
                      <span className="text-success-strong">Agrees exactly</span>
                    ) : (
                      <>
                        {formatMoney(reconciliation.order_line_gap, currency)}{" "}
                        <span className="text-muted-foreground">
                          — shipping, order-level discounts and orders with no
                          lines. Expected, not an error.
                        </span>
                      </>
                    )}
                  </span>
                </li>

                {reconciliation.orders_without_lines > 0 && (
                  <li className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">
                      Orders with no product lines
                    </span>
                    <span className="tabular-nums">
                      {reconciliation.orders_without_lines}
                    </span>
                  </li>
                )}
              </ul>
            </div>

            <div className="mt-6 rounded-xl border border-border bg-card px-5 py-4">
              <h2 className="text-sm font-semibold">
                How BizMind treats a missing value
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                A blank stays unknown. It is never read as a zero, because a
                zero is a claim — that something cost nothing, or that a
                marketplace charged no fee. Figures built on incomplete inputs
                are marked, and alerts about profit refuse to fire until the
                gap is closed.
              </p>
              <Button asChild size="sm" variant="outline" className="mt-4 rounded-4xl">
                <Link href="/imports/new">Import the missing data</Link>
              </Button>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}

/** A coverage percentage, or an honest dash when it could not be measured. */
function Coverage({
  label,
  value,
  detail,
}: {
  label: string
  value: string | null
  detail: string
}) {
  return (
    <div className="bg-card px-5 py-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
        {value === null ? "—" : `${value}%`}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}
