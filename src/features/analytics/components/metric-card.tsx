import { Info } from "lucide-react"

import { cn } from "cn"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { DeltaChip } from "./delta-chip"

/**
 * A single business figure.
 *
 * Anatomy, per DESIGN.md: label, then the number as the loudest thing in the
 * card, then the change beside it. The figure is mono and tabular so a column
 * of cards lines up and can be scanned vertically.
 *
 * `explanation` describes how the number was calculated. An owner acting on a
 * figure deserves to know what went into it, and it also documents the
 * boundary this product depends on: these are computed in SQL, not estimated.
 */
export function MetricCard({
  label,
  value,
  change,
  higherIsBetter = true,
  explanation,
  secondary,
  emphasis = false,
  warning,
}: {
  label: string
  value: string
  change?: number | null
  higherIsBetter?: boolean
  explanation?: string
  secondary?: string
  emphasis?: boolean
  warning?: string
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4",
        emphasis && "ring-1 ring-primary/20"
      )}
    >
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {explanation && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`How ${label} is calculated`}
                className="text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                <Info className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{explanation}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <p
        className={cn(
          "mt-2 font-mono font-semibold tabular-nums",
          emphasis ? "text-2xl" : "text-xl"
        )}
      >
        {value}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {change !== undefined && (
          <DeltaChip change={change} higherIsBetter={higherIsBetter} />
        )}
        {secondary && (
          <span className="text-xs text-muted-foreground">{secondary}</span>
        )}
      </div>

      {warning && (
        <p className="mt-2.5 text-xs text-warning-strong">{warning}</p>
      )}
    </div>
  )
}
