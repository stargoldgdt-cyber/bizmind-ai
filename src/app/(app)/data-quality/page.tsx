import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

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
import { PageHeader } from "@/features/analytics/components/page-header"
import { QualityPanel } from "@/features/analytics/components/quality-panel"
import {
  channelFromParams,
  filterHref,
  scopeFor,
} from "@/features/analytics/dashboard-params"
import { loadAnalyticsPage, param } from "@/features/analytics/page-context"
import { formatMoney, formatNumber } from "@/lib/format"
import {
  getDataQuality,
  listQualityOrders,
  type AnalyticsScope,
  type QualityIssue,
} from "@/services/analytics"

export const metadata: Metadata = { title: "Data quality" }

/**
 * Data quality, and the orders behind each gap.
 *
 * WHY THIS IS A PAGE AND NOT A WARNING BANNER
 * -------------------------------------------
 * Every other tool an owner has used reported a margin without saying how much
 * of it was guesswork. BizMind knows exactly which order lines have no cost,
 * which orders have no fee, and which lines have no value at all — so it can
 * state each gap, say what it does to the figures, and then show the orders.
 *
 * A count nobody can open is a number to feel bad about. A count that opens
 * into "these eleven orders, on these dates" is something to fix.
 *
 * The list is paged in the database; a business with 80,000 orders does not
 * ship them to a browser.
 */

const ISSUES: Record<QualityIssue, { title: string; explanation: string }> = {
  MISSING_COST: {
    title: "Orders with lines that have no recorded cost",
    explanation:
      "Cost is recorded at the time of sale. BizMind will not take it from your product list, because that is today's price and this is a past sale.",
  },
  NO_FEE: {
    title: "Orders with no recorded fee",
    explanation:
      "Treated as unknown rather than zero, so these orders' profit is higher than reality by an unknown amount.",
  },
  NO_CHANNEL: {
    title: "Orders attributed to no channel",
    explanation:
      "They count toward your totals but belong to no channel, so channel figures do not add up to your full revenue.",
  },
  NO_CUSTOMER: {
    title: "Orders with no customer",
    explanation:
      "A customer is recognised by email address across channels. Without one, repeat-customer figures miss these orders.",
  },
  UNKNOWN_VALUE: {
    title: "Orders with lines that have no value",
    explanation:
      "No line total and no unit price, so what the line sold for is unknown. Those lines are left out of product figures rather than counted as zero.",
  },
  NO_LINES: {
    title: "Orders with no product lines",
    explanation:
      "The order total is recorded but nothing says what was sold, so these orders cannot appear in product figures.",
  },
}

function isIssue(value: string | undefined): value is QualityIssue {
  return value !== undefined && value in ISSUES
}

export default async function DataQualityPage(props: PageProps<"/data-quality">) {
  const searchParams = await props.searchParams
  const context = await loadAnalyticsPage(searchParams)
  const { business, period, hasSales } = context

  const channelChoice = channelFromParams(searchParams)
  const scope = scopeFor(channelChoice)
  const issueParam = param(searchParams, "issue")
  const issue = isIssue(issueParam) ? issueParam : null

  const quality = await getDataQuality(business.id, period, { scope })
  const currency = business.currency

  return (
    <AppShell
      businesses={context.businesses}
      activeBusinessId={business.id}
      userEmail={context.user.email}
      userName={context.userName}
    >
      <div className="mx-auto max-w-5xl">
        <PageHeader
          title="What is missing"
          description="How much of what BizMind tells you can be relied on, what each gap does to the figures, and the orders behind it."
          period={period}
          currency={currency}
          basePath="/data-quality"
        />

        {!hasSales || !quality ? (
          <p className="mt-8 rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            Nothing was recorded in this period, so there is nothing to assess.
          </p>
        ) : issue ? (
          <IssueDetail
            issue={issue}
            businessId={business.id}
            period={period}
            scope={scope}
            currency={currency}
            backHref={filterHref("/data-quality", searchParams, { issue: null })}
          />
        ) : (
          <>
            <div className="mt-8">
              <QualityPanel
                quality={quality}
                hrefForIssue={(next) =>
                  filterHref("/data-quality", searchParams, { issue: next })
                }
              />
            </div>

            <div className="mt-6 rounded-xl border border-border bg-card px-5 py-4">
              <h2 className="text-sm font-semibold">
                How BizMind treats a missing value
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                A blank stays unknown. It is never read as a zero, because a
                zero is a claim — that something cost nothing, or that a
                marketplace charged no fee. Figures built on incomplete inputs
                are marked, and alerts about profit refuse to fire until the gap
                is closed. Where a line has a unit price but no line total, its
                value is calculated and labelled as calculated, never presented
                as a figure your file supplied.
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

async function IssueDetail({
  issue,
  businessId,
  period,
  scope,
  currency,
  backHref,
}: {
  issue: QualityIssue
  businessId: string
  period: Awaited<ReturnType<typeof loadAnalyticsPage>>["period"]
  scope: AnalyticsScope
  currency: string
  backHref: string
}) {
  const { rows, matchedCount } = await listQualityOrders(businessId, period, issue, {
    limit: 100,
    scope,
  })

  const copy = ISSUES[issue]

  return (
    <div className="mt-8">
      <Button asChild size="sm" variant="ghost" className="mb-3 rounded-4xl">
        <Link href={backHref}>
          <ArrowLeft className="size-4" aria-hidden />
          All gaps
        </Link>
      </Button>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">{copy.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.explanation}</p>
          <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">
            {formatNumber(matchedCount)} order{matchedCount === 1 ? "" : "s"} in this period
            {matchedCount > rows.length && ` · showing the most recent ${rows.length}`}
          </p>
        </div>

        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            No orders match this gap in the selected period.
          </p>
        ) : (
          <div className="overflow-x-auto [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Placed</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Fee</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Without cost</TableHead>
                  <TableHead className="text-right">No value</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.order_id}>
                    <TableCell className="font-mono text-xs">
                      {row.order_number ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(row.placed_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.channel_name ?? (
                        <span className="text-muted-foreground">No channel</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatMoney(row.total, currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {row.fee_total === null ? "not recorded" : formatMoney(row.fee_total, currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatNumber(row.items_total)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {row.items_without_cost > 0 ? formatNumber(row.items_without_cost) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {row.items_value_unknown > 0 ? formatNumber(row.items_value_unknown) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="border-t border-border px-5 py-3">
          <Button asChild size="sm" variant="outline" className="rounded-4xl">
            <Link href="/imports/new">Import the missing data</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
