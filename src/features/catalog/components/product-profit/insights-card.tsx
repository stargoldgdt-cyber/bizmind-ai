import { Sparkles } from "lucide-react"

import type { Insight } from "@/services/catalog/product-profit-view"

const DOT = {
  danger: "bg-danger",
  warning: "bg-warning",
  success: "bg-success",
  info: "bg-info",
} as const

/**
 * Plain observations drawn from the figures on this page. They are written by
 * fixed rules from verified numbers, so the panel is called Insights, not AI:
 * no model produced a word of it, and none could change a figure.
 */
export function InsightsCard({ insights }: { insights: Insight[] }) {
  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-surface-2 p-5">
      <header className="flex items-center gap-2.5">
        <Sparkles className="size-5 text-primary" aria-hidden />
        <h2 className="text-base font-semibold">Insights</h2>
      </header>

      {insights.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Nothing stands out for this choice.</p>
      ) : (
        <ul className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          {insights.map((insight) => (
            <li key={insight.title} className="flex gap-3">
              <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${DOT[insight.tone]}`} aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{insight.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{insight.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
