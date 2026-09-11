import Link from "next/link"
import { CircleCheck, TriangleAlert } from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"
import type { Financials } from "@/services/analytics"

/**
 * Data quality, in the owner's language.
 *
 * WHY THIS IS A FEATURE AND NOT A FOOTNOTE
 * ----------------------------------------
 * Every other tool an owner has tried reported a margin without telling them
 * how much of it was guesswork. BizMind knows precisely which order lines have
 * no cost recorded and which orders have no fee, so it can say what the gap is
 * and which direction it moves the figure.
 *
 * That is the difference between a number and a number you can act on.
 *
 * THE TRANSLATION RULE
 * --------------------
 * "cost_coverage = 75%" is a fact about a column. "Costs recorded for 75% of
 * order lines — profit may be overstated" is a fact about the business. Only
 * the second one belongs on screen; the first one belongs in the tooltip that
 * explains it.
 *
 * NOTHING HERE IS CALCULATED. Coverage figures and counts arrive from the
 * analytics service, already computed in SQL.
 */

type Issue = {
  title: string
  detail: string
  /** Which way it moves the figures. Stated, never left for the reader. */
  effect: string
}

export function DataQuality({
  current,
  className,
}: {
  current: Financials
  className?: string
}) {
  const issues: Issue[] = []

  const missingCostLines = current.items_total - current.items_with_cost
  if (missingCostLines > 0) {
    issues.push({
      title: `Costs are missing on ${missingCostLines} of ${current.items_total} order lines`,
      detail:
        current.cost_coverage === null
          ? "Cost coverage could not be measured for this period."
          : `Costs are recorded for ${current.cost_coverage}% of what you sold.`,
      effect: "Profit and margin are higher than reality until these are filled in.",
    })
  }

  if (current.orders_fees_unknown > 0) {
    issues.push({
      title: `Fees are missing on ${current.orders_fees_unknown} of ${current.orders_count} orders`,
      detail:
        "A missing fee is treated as unknown, never as zero — so these orders " +
        "are excluded from the fee figure rather than counted as free.",
      effect: "Profit is higher than reality for those orders.",
    })
  }

  if (current.orders_without_channel > 0) {
    issues.push({
      title: `${current.orders_without_channel} orders have no channel`,
      detail: "They count toward your totals but not toward any channel.",
      effect: "Channel profitability does not add up to your full revenue.",
    })
  }

  if (issues.length === 0) {
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-xl border border-success/25 bg-success-subtle px-5 py-4",
          className
        )}
      >
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-strong" aria-hidden />
        <div>
          <p className="text-sm font-medium text-success-strong">
            Everything needed for these figures is recorded
          </p>
          <p className="mt-0.5 text-xs text-success-strong/85">
            Costs and fees are present on every order in this period, so the
            profit figures are complete.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <TriangleAlert className="size-4 text-warning-strong" aria-hidden />
          <h2 className="text-sm font-semibold">
            What is missing from your data
          </h2>
        </div>

        {/*
          Links to the import wizard, which is the real and only way to supply
          the missing figures today. There is no repair screen, so this does
          not pretend there is one.
        */}
        <Button asChild size="sm" variant="outline" className="rounded-4xl">
          <Link href="/imports/new">Import the missing data</Link>
        </Button>
      </div>

      <ul className="divide-y divide-border">
        {issues.map((issue) => (
          <li key={issue.title} className="px-5 py-4">
            <p className="text-sm font-medium">{issue.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{issue.detail}</p>
            <p className="mt-1.5 text-xs font-medium text-warning-strong">
              {issue.effect}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}
