import Link from "next/link"

import { cn } from "cn"
import { PERIOD_OPTIONS, type ResolvedPeriod } from "@/services/analytics"

/**
 * Period selector.
 *
 * Plain links rather than client state. The period lives in the URL, so it
 * survives a refresh, can be bookmarked and shared, and works before any
 * JavaScript loads.
 */
export function RangeSelector({ active }: { active: ResolvedPeriod["key"] }) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded-4xl border border-border bg-card p-1"
      role="group"
      aria-label="Reporting period"
    >
      {PERIOD_OPTIONS.map((option) => {
        const selected = option.value === active
        return (
          <Link
            key={option.value}
            href={`/dashboard?range=${option.value}`}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "rounded-4xl px-3 py-1.5 text-xs font-medium transition-colors",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {option.label}
          </Link>
        )
      })}
    </div>
  )
}
