import Link from "next/link"

import { cn } from "cn"
import { RANGE_OPTIONS, type RangeValue } from "@/features/analytics/types"

/**
 * Period selector.
 *
 * Plain links rather than a client component with state. The period lives in
 * the URL, which means it survives a refresh, can be bookmarked, and works
 * before any JavaScript loads.
 */
export function RangeSelector({ active }: { active: RangeValue }) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded-4xl border border-border bg-card p-1"
      role="group"
      aria-label="Reporting period"
    >
      {RANGE_OPTIONS.map((option) => {
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
