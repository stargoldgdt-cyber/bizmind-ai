import Link from "next/link"
import { ArrowRight, CircleCheck } from "lucide-react"

import { formatNumber, formatPercent } from "@/lib/format"
import type { DataQuality, QualityIssue } from "@/services/analytics"

/**
 * Data quality as an intelligence layer, not an error list.
 *
 * Each line is a pair and a consequence: how much is recorded, how much is
 * not, and what that does to the figures above. "95.3% cost coverage" is a
 * fact about a column; "10 of 233 order lines have no cost, so profit is
 * higher than reality" is a fact about the business, and only the second one
 * is worth an owner's attention.
 *
 * Every gap that can be opened links to the orders behind it. A gap with
 * nothing behind it is not shown at all: a list of green ticks trains people
 * to stop reading the list.
 */

type Gap = {
  key: string
  title: string
  detail: string
  effect: string
  coverage: string | null
  issue?: QualityIssue
}

export function QualityPanel({
  quality,
  hrefForIssue,
}: {
  quality: DataQuality
  /** Links a gap to the orders behind it. */
  hrefForIssue: (issue: QualityIssue) => string
}) {
  const gaps: Gap[] = []

  if (quality.items_without_cost > 0) {
    gaps.push({
      key: "cost",
      title: `${formatNumber(quality.items_without_cost)} of ${formatNumber(
        quality.items_total
      )} order lines have no recorded cost`,
      detail: "Cost is recorded at the time of sale, so it cannot be filled in from your product list.",
      effect: "Profit and margin are higher than reality until these are supplied.",
      coverage: quality.cost_coverage,
      issue: "MISSING_COST",
    })
  }

  if (quality.orders_without_fee > 0) {
    gaps.push({
      key: "fee",
      title: `${formatNumber(quality.orders_without_fee)} of ${formatNumber(
        quality.orders_count
      )} orders have no recorded fee`,
      detail: "A missing fee is treated as unknown, never as zero.",
      effect: "Profit on those orders is higher than reality.",
      coverage: quality.fee_coverage,
      issue: "NO_FEE",
    })
  }

  if (quality.orders_without_channel > 0) {
    gaps.push({
      key: "channel",
      title: `${formatNumber(quality.orders_without_channel)} orders are not attributed to a channel`,
      detail: "They count toward your totals but belong to no channel.",
      effect: "Channel comparisons do not add up to your full revenue.",
      coverage: quality.channel_coverage,
      issue: "NO_CHANNEL",
    })
  }

  if (quality.items_value_unknown > 0) {
    gaps.push({
      key: "value",
      title: `${formatNumber(quality.items_value_unknown)} order lines have no value at all`,
      detail: "No line total and no unit price, so what they sold for is unknown.",
      effect: "They are left out of product figures rather than counted as zero.",
      coverage: quality.value_coverage,
      issue: "UNKNOWN_VALUE",
    })
  }

  if (quality.items_without_identity > 0) {
    gaps.push({
      key: "identity",
      title: `${formatNumber(quality.items_without_identity)} order lines cannot be identified`,
      detail: "No SKU, no product link and no name, so they cannot be told apart.",
      effect: "They are grouped together, so per-product analysis misses them.",
      coverage: quality.identity_coverage,
    })
  }

  if (quality.orders_without_customer > 0) {
    gaps.push({
      key: "customer",
      title: `${formatNumber(quality.orders_without_customer)} of ${formatNumber(
        quality.orders_count
      )} orders have no customer`,
      detail: "A customer is recognised by email address across channels.",
      effect: "Repeat-customer figures cover only the orders that have one.",
      coverage: quality.customer_coverage,
      issue: "NO_CUSTOMER",
    })
  }

  const measured = [
    { label: "Cost", value: quality.cost_coverage },
    { label: "Fees", value: quality.fee_coverage },
    { label: "Channel", value: quality.channel_coverage },
    { label: "Product identity", value: quality.identity_coverage },
    { label: "Line value", value: quality.value_coverage },
    { label: "Customer", value: quality.customer_coverage },
  ]

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {measured.map((item) => (
          <div key={item.label} className="bg-card px-4 py-3">
            <p className="text-[11px] text-muted-foreground">{item.label}</p>
            <p className="mt-0.5 font-mono text-sm font-medium tabular-nums">
              {formatPercent(item.value)}
            </p>
          </div>
        ))}
      </div>

      {gaps.length === 0 ? (
        <div className="flex items-start gap-3 px-5 py-4">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-strong" aria-hidden />
          <div>
            <p className="text-sm font-medium text-success-strong">
              Everything these figures need is recorded
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Costs, fees, channels and line values are present on every order
              in this period, so nothing above is overstated.
            </p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {gaps.map((gap) => (
            <li key={gap.key} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{gap.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{gap.detail}</p>
                  <p className="mt-1.5 text-xs font-medium text-warning-strong">{gap.effect}</p>
                </div>

                {gap.issue && (
                  <Link
                    href={hrefForIssue(gap.issue)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-4xl border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                  >
                    See the orders
                    <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        {quality.days_with_orders === 0
          ? "No orders were placed in this period."
          : `Orders were placed on ${formatNumber(quality.days_with_orders)} of the ${formatNumber(
              quality.days_in_period
            )} days in this period.`}
        {quality.days_since_last_order !== null &&
          quality.days_since_last_order > 1 &&
          ` The most recent order was ${formatNumber(quality.days_since_last_order)} days ago.`}
      </p>
    </div>
  )
}
