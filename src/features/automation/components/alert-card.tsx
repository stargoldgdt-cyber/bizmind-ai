"use client"

import { useTransition } from "react"
import { Check, CircleAlert, Info, TriangleAlert } from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { acknowledgeAlertAction } from "@/features/automation/actions"
import type { PresentedAlert } from "@/services/automation"

/**
 * One alert.
 *
 * WHAT AN ALERT HAS TO SHOW TO BE ACTED ON
 * ----------------------------------------
 * Not just "gross margin is low". The figure that fired it, the line it
 * crossed, and the window both were measured over — because the first question
 * an owner asks is "by how much?" and the second is "over what period?". An
 * alert that cannot answer those gets ignored, then muted.
 *
 * The value and threshold are formatted by `presentAlert()` on the server,
 * which reads the stored operator to know whether the figure is money or a
 * percentage change. Nothing is converted here.
 */

const SEVERITY = {
  CRITICAL: {
    icon: CircleAlert,
    chip: "border-danger/30 bg-danger-subtle text-danger-strong",
    label: "Critical",
  },
  WARNING: {
    icon: TriangleAlert,
    chip: "border-warning/30 bg-warning-subtle text-warning-strong",
    label: "Warning",
  },
  INFO: {
    icon: Info,
    chip: "border-info/30 bg-info-subtle text-info-strong",
    label: "For information",
  },
} as const

export function AlertCard({ presented }: { presented: PresentedAlert }) {
  const [pending, startTransition] = useTransition()
  const { alert, metricLabel, value, threshold } = presented

  const severity = SEVERITY[alert.severity]
  const Icon = severity.icon
  const open = alert.status === "OPEN"

  return (
    <li
      className={cn(
        "rounded-xl border bg-card p-5",
        open ? "border-border" : "border-border/60 opacity-70"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <Icon
            className={cn(
              "mt-0.5 size-4 shrink-0",
              alert.severity === "CRITICAL" && "text-danger-strong",
              alert.severity === "WARNING" && "text-warning-strong",
              alert.severity === "INFO" && "text-info-strong"
            )}
            aria-hidden
          />

          <div className="min-w-0">
            <h3 className="font-medium">{alert.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{alert.body}</p>
          </div>
        </div>

        <span
          className={cn(
            "shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium",
            severity.chip
          )}
        >
          {severity.label}
        </span>
      </div>

      {/* The working: what it measured, against what, over how long. */}
      <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        <Figure label={metricLabel} value={value} emphasis />
        <Figure label="Your limit" value={threshold} />
        <Figure label="Measured over" value={`${alert.period_days} days`} />
        <Figure
          label="Raised"
          value={new Date(alert.created_at).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        />
      </dl>

      <div className="mt-4 flex items-center justify-between gap-3">
        {open ? (
          <Button
            size="sm"
            variant="outline"
            className="rounded-4xl"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await acknowledgeAlertAction({ id: alert.id })
              })
            }
          >
            <Check className="size-4" aria-hidden />
            {pending ? "Marking…" : "Mark as seen"}
          </Button>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5" aria-hidden />
            Seen
            {alert.acknowledged_at &&
              ` on ${new Date(alert.acknowledged_at).toLocaleDateString()}`}
          </p>
        )}
      </div>
    </li>
  )
}

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className="bg-card px-3.5 py-2.5">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 font-mono text-sm tabular-nums",
          emphasis && "font-semibold"
        )}
      >
        {value}
      </dd>
    </div>
  )
}
