import Link from "next/link"
import { ArrowRight, CircleAlert, CircleCheck, Lightbulb, TrendingDown } from "lucide-react"

import type { Priority, ProductInsights } from "@/services/catalog/product-analysis-view"

/**
 * What to do about this product and why. Words come from fixed rules over
 * figures the database already worked out (product-analysis-view.ts); no model
 * writes them, so the panel is called Insights, not AI. The priority is the
 * product's status as a word AND an icon, never colour alone.
 */

const PRIORITY: Record<Priority, { icon: typeof CircleAlert; className: string }> = {
  High: { icon: TrendingDown, className: "bg-danger-subtle text-danger-strong" },
  Medium: { icon: CircleAlert, className: "bg-warning-subtle text-warning-strong" },
  Low: { icon: CircleCheck, className: "bg-muted text-muted-foreground" },
}

export function InsightsPanel({
  insights,
  editHref,
  canManage,
}: {
  insights: ProductInsights
  editHref: string
  canManage: boolean
}) {
  const priority = PRIORITY[insights.priority]
  const PriorityIcon = priority.icon
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 font-heading text-base font-semibold">
            <Lightbulb className="size-4 text-primary" aria-hidden />
            Insights and recommendation
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Worked out from this product&apos;s own figures.</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${priority.className}`}>
          <PriorityIcon className="size-3.5" aria-hidden />
          Priority: {insights.priority}
        </span>
      </div>

      <div className="grid gap-5 p-5">
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="font-semibold">{insights.headline}</p>
          <p className="mt-1 text-sm text-muted-foreground">{insights.summary}</p>
        </div>

        {insights.reasons.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Key reasons</h3>
            <ol className="mt-2 divide-y divide-border rounded-lg border border-border">
              {insights.reasons.map((reason, index) => (
                <li key={reason.key} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 font-medium">{reason.title}</span>
                  <span className="text-right text-xs text-muted-foreground tabular-nums">{reason.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {insights.actions.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Recommended actions</h3>
            <ol className="mt-2 grid gap-2">
              {insights.actions.map((action, index) => (
                <li key={action.key} className="flex items-start gap-3 rounded-lg border border-border p-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular-nums">
                    {index + 1}
                  </span>
                  <span className="text-sm">
                    <span className="block font-semibold">{action.title}</span>
                    <span className="block text-muted-foreground">{action.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {canManage && (
          <Link href={editHref} className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-primary hover:underline">
            Edit this product&apos;s cost
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        )}
      </div>
    </section>
  )
}
