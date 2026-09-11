import type { Metadata } from "next"

import { AppShell } from "@/components/layout/app-shell"
import { ChannelTable } from "@/features/analytics/components/channel-table"
import { PageHeader } from "@/features/analytics/components/page-header"
import { loadAnalyticsPage } from "@/features/analytics/page-context"
import { formatMoney } from "@/lib/format"
import { compareMoney } from "@/services/analytics/money"

export const metadata: Metadata = { title: "Channels" }

/**
 * Channel profitability.
 *
 * The question this page exists for: revenue tells you where you are busy,
 * margin tells you where you are paid. They are frequently different places,
 * and the marketplace that dominates the revenue column is often the one
 * returning the least.
 *
 * THE HEADLINE IS ONLY STATED WHEN THE FIGURES SUPPORT IT.
 * The comparison below is a ranking — "which channel has the highest revenue"
 * against "which has the highest margin" — done with `compareMoney`, which
 * compares exact decimal strings without converting them. No arithmetic is
 * performed on either figure, and if the two rankings agree, no claim is made
 * at all.
 */
export default async function ChannelsPage(props: PageProps<"/channels">) {
  const context = await loadAnalyticsPage(await props.searchParams)
  const { analytics, business, period, hasSales } = context
  const { channels, reconciliation } = analytics
  const currency = business.currency

  // Ranked, never summed. `compareMoney` orders exact decimal text.
  const measured = channels.filter((channel) => channel.gross_margin !== null)

  const byRevenue = [...channels].sort((a, b) =>
    compareMoney(b.revenue, a.revenue)
  )[0]

  const byMargin = [...measured].sort((a, b) =>
    compareMoney(b.gross_margin ?? "0", a.gross_margin ?? "0")
  )[0]

  const contrast =
    byRevenue && byMargin && byRevenue.channel_id !== byMargin.channel_id
      ? { top: byRevenue, best: byMargin }
      : null

  return (
    <AppShell
      businesses={context.businesses}
      activeBusinessId={business.id}
      userEmail={context.user.email}
      userName={context.userName}
    >
      <div className="mx-auto max-w-5xl">
        <PageHeader
          title="Channels"
          description="Revenue shows where you are busy. Margin shows where you are paid."
          period={period}
          currency={currency}
          basePath="/channels"
        />

        {!hasSales || channels.length === 0 ? (
          <p className="mt-8 rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            No channel activity in this period.
          </p>
        ) : (
          <>
            {contrast && (
              <p className="mt-8 rounded-xl border border-border bg-card px-5 py-4 text-sm">
                <span className="font-medium">{contrast.best.channel_name}</span>{" "}
                earns a better margin than{" "}
                <span className="font-medium">{contrast.top.channel_name}</span>,
                which brings in more revenue. Where you grow next is a choice
                between the two.
              </p>
            )}

            <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
              <ChannelTable channels={channels} currency={currency} />
            </div>

            <div className="mt-4 space-y-1 text-xs text-muted-foreground">
              <p>
                Fees are counted per channel from each channel&apos;s own
                figures, so the margin column shows what that channel actually
                returns — not an average spread across all of them.
              </p>

              {Number(reconciliation.channel_difference) !== 0 && (
                <p className="text-danger-strong">
                  Channel revenue does not reconcile with total revenue — a
                  difference of{" "}
                  {formatMoney(reconciliation.channel_difference, currency)}.
                  Please report this.
                </p>
              )}

              {analytics.current.orders_without_channel > 0 && (
                <p>
                  {analytics.current.orders_without_channel} orders have no
                  channel recorded. They count toward your totals but appear in
                  no row above.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
