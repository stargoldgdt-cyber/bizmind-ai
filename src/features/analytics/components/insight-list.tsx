import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react"

import { cn } from "cn"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import type { Insight, InsightSeverity } from "@/services/analytics"

/**
 * What the numbers mean.
 *
 * Every insight here came from a deterministic rule over verified figures —
 * no model wrote any of it. The supporting metrics are shown alongside each
 * finding so the reasoning can be checked rather than taken on trust.
 */

const SEVERITY: Record<
  InsightSeverity,
  { style: string; icon: typeof Info; label: string }
> = {
  critical: {
    style: "border-danger/25 bg-danger-subtle text-danger-strong",
    icon: CircleAlert,
    label: "Needs attention",
  },
  warning: {
    style: "border-warning/25 bg-warning-subtle text-warning-strong",
    icon: TriangleAlert,
    label: "Worth checking",
  },
  positive: {
    style: "border-success/25 bg-success-subtle text-success-strong",
    icon: CircleCheck,
    label: "Going well",
  },
  info: {
    style: "border-info/25 bg-info-subtle text-info-strong",
    icon: Info,
    label: "For information",
  },
}

export function InsightList({
  insights,
  currency,
}: {
  insights: Insight[]
  currency: string
}) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>What this means</CardTitle>
        <CardDescription>
          Findings from fixed rules applied to your own figures. Nothing is
          generated, and nothing acts on its own.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {insights.length === 0 ? (
          // An empty result is a real answer. Padding it with filler would
          // teach people to stop reading this section.
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing stands out in this period. When something does, it appears
            here.
          </p>
        ) : (
          <ul className="space-y-3">
            {insights.map((insight, index) => (
              <li key={`${insight.type}-${index}`}>
                <InsightItem insight={insight} currency={currency} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function InsightItem({ insight, currency }: { insight: Insight; currency: string }) {
  const severity = SEVERITY[insight.severity]
  const Icon = severity.icon

  return (
    <article className={cn("rounded-xl border p-4", severity.style)}>
      <header className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-wide uppercase opacity-80">
            {severity.label}
          </p>
          <h3 className="mt-0.5 font-heading text-sm font-semibold">{insight.title}</h3>
        </div>
      </header>

      <p className="mt-2.5 text-sm text-foreground/85">{insight.summary}</p>

      {insight.supportingMetrics.length > 0 && (
        <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {insight.supportingMetrics.map((metric, i) => (
            <div key={`${metric.label}-${i}`} className="flex items-baseline justify-between gap-3">
              <dt className="truncate text-xs text-foreground/70">{metric.label}</dt>
              <dd className="shrink-0 font-mono text-xs tabular-nums">
                {metric.format === "money"
                  ? formatMoney(metric.value, currency)
                  : metric.format === "percent"
                    ? formatPercent(metric.value)
                    : metric.format === "count"
                      ? formatNumber(metric.value)
                      : metric.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-3 space-y-1.5 border-t border-current/15 pt-3">
        <p className="text-xs">
          <span className="font-medium">Why it matters: </span>
          <span className="text-foreground/80">{insight.businessImpact}</span>
        </p>
        <p className="text-xs">
          <span className="font-medium">What to look at: </span>
          <span className="text-foreground/80">{insight.recommendedNextStep}</span>
        </p>
      </div>
    </article>
  )
}
