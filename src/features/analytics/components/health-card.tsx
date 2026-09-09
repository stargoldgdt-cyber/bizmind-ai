import { CircleHelp, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react"

import { cn } from "cn"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import type { BusinessHealth, HealthDimension, HealthStatus } from "@/services/analytics"

/**
 * Business Health Score.
 *
 * Shows the reasoning as prominently as the number. A score an owner cannot
 * interrogate is a score they should not act on, so every dimension states
 * why it scored what it did, and an unmeasurable one says so rather than
 * showing a comfortable middle value.
 */

const STATUS_STYLE: Record<HealthStatus, string> = {
  strong: "bg-success-subtle text-success-strong",
  healthy: "bg-success-subtle text-success-strong",
  watch: "bg-warning-subtle text-warning-strong",
  at_risk: "bg-danger-subtle text-danger-strong",
  unknown: "bg-muted text-muted-foreground",
}

const STATUS_LABEL: Record<HealthStatus, string> = {
  strong: "Strong",
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
  unknown: "Not enough data",
}

export function HealthCard({ health, currency }: { health: BusinessHealth; currency: string }) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Business health</CardTitle>
        <CardDescription>
          Every threshold behind this score is published and fixed. Nothing here
          is generated or estimated.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-4xl font-semibold tabular-nums">
              {health.score ?? "—"}
            </span>
            {health.score !== null && (
              <span className="text-sm text-muted-foreground">/ 100</span>
            )}
          </div>

          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-4xl px-2.5 py-1 text-xs font-medium",
              STATUS_STYLE[health.status]
            )}
          >
            {health.status === "unknown" ? (
              <CircleHelp className="size-3.5" aria-hidden />
            ) : health.status === "at_risk" ? (
              <ShieldAlert className="size-3.5" aria-hidden />
            ) : health.status === "watch" ? (
              <TriangleAlert className="size-3.5" aria-hidden />
            ) : (
              <ShieldCheck className="size-3.5" aria-hidden />
            )}
            {STATUS_LABEL[health.status]}
          </span>

          <span className="text-xs text-muted-foreground">
            {health.dimensionsScored} of {health.dimensionsTotal} areas measurable
          </span>
        </div>

        <p className="text-sm text-muted-foreground">{health.summary}</p>

        <div className="grid gap-3 sm:grid-cols-2">
          {health.dimensions.map((dimension) => (
            <DimensionRow key={dimension.key} dimension={dimension} currency={currency} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function DimensionRow({
  dimension,
  currency,
}: {
  dimension: HealthDimension
  currency: string
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{dimension.label}</p>
        <span
          className={cn(
            "shrink-0 rounded-4xl px-2 py-0.5 font-mono text-xs font-medium tabular-nums",
            STATUS_STYLE[dimension.status]
          )}
        >
          {dimension.score ?? "—"}
        </span>
      </div>

      <p className="mt-1.5 text-xs text-muted-foreground">{dimension.reason}</p>

      {dimension.caveat && (
        <p className="mt-1.5 text-xs text-warning-strong">{dimension.caveat}</p>
      )}

      {dimension.supporting.length > 0 && (
        <dl className="mt-2.5 space-y-1">
          {dimension.supporting.map((metric) => (
            <div key={metric.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-[11px] text-muted-foreground">{metric.label}</dt>
              <dd className="font-mono text-[11px] tabular-nums">
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
    </div>
  )
}
