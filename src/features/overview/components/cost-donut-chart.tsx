"use client"

import { useState } from "react"

import { formatMoney, formatPercent } from "@/lib/format"
import type { CostRow } from "@/features/overview/queries"

/**
 * Where marketplace costs go, as a donut: each category's own validated
 * chart colour, assigned by category code (never by row order), so the same
 * cost always reads as the same colour period to period. Segment size comes
 * straight from `bar` (0-1000, dashboard_cost_breakdown) -- nothing here
 * adds percentages up to place a slice.
 */

// Fixed per-category colour, not per-rank: DESIGN.md's "colour follows the
// entity, not its rank." A category not in this list (a new one added later)
// falls back to chart-2.
const CATEGORY_COLOUR: Record<string, string> = {
  MARKETPLACE_FEE: "var(--color-chart-1)",
  FULFILLMENT: "var(--color-chart-4)",
  ADVERTISING: "var(--color-chart-3)",
  REFUND_FEE: "var(--color-chart-5)",
  PAYMENT_FEE: "var(--color-chart-6)",
  STORAGE: "var(--color-chart-2)",
}
const FALLBACK_COLOUR = "var(--color-chart-2)"

const SIZE = 200
const STROKE = 26
const R = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * R

export function CostDonutChart({
  rows,
  total,
  currency,
}: {
  rows: CostRow[]
  total: string | null
  currency: string
}) {
  const [mode, setMode] = useState<"amount" | "percent">("amount")
  const [active, setActive] = useState<string | null>(null)

  if (rows.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">No marketplace costs in this period.</p>
  }

  const segments = rows.reduce<{ row: CostRow; length: number; offset: number; colour: string }[]>((acc, row) => {
    const length = (row.bar / 1000) * CIRCUMFERENCE
    const offset = acc.length === 0 ? 0 : acc[acc.length - 1].offset + acc[acc.length - 1].length
    acc.push({ row, length, offset, colour: CATEGORY_COLOUR[row.category] ?? FALLBACK_COLOUR })
    return acc
  }, [])

  return (
    <div className="flex flex-col gap-5 px-5 py-4 sm:flex-row sm:items-center">
      <div className="relative mx-auto shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Where marketplace costs go, by category">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--color-muted)" strokeWidth={STROKE} />
          {segments.map((s) => (
            <circle
              key={s.row.category}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={s.colour}
              strokeWidth={STROKE}
              strokeDasharray={`${s.length} ${CIRCUMFERENCE - s.length}`}
              strokeDashoffset={-s.offset}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              opacity={active === null || active === s.row.category ? 1 : 0.35}
              className="cursor-pointer transition-opacity"
              tabIndex={0}
              role="listitem"
              aria-label={`${s.row.label}: ${formatMoney(s.row.total, currency)}${s.row.pct_of_costs !== null ? `, ${formatPercent(s.row.pct_of_costs)} of costs` : ""}`}
              onMouseEnter={() => setActive(s.row.category)}
              onFocus={() => setActive(s.row.category)}
              onMouseLeave={() => setActive(null)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <p className="font-mono text-lg font-bold tabular-nums">{formatMoney(total, currency, { compact: true })}</p>
          <p className="text-[11px] text-muted-foreground">Total costs</p>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex w-fit gap-0.5 rounded-full border border-border bg-muted/40 p-0.5 text-xs font-medium">
          {(["amount", "percent"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                mode === m
                  ? "rounded-full bg-primary px-3 py-1 text-primary-foreground"
                  : "rounded-full px-3 py-1 text-muted-foreground hover:text-foreground"
              }
            >
              {m === "amount" ? "Amount" : "Percentage"}
            </button>
          ))}
        </div>
        <ul className="flex flex-col gap-2">
          {segments.map((s) => (
            <li
              key={s.row.category}
              className="flex items-center justify-between gap-3 text-sm"
              onMouseEnter={() => setActive(s.row.category)}
              onMouseLeave={() => setActive(null)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.colour }} aria-hidden />
                <span className="truncate">{s.row.label}</span>
              </span>
              <span className="font-mono tabular-nums whitespace-nowrap">
                {mode === "amount" ? formatMoney(s.row.total, currency) : s.row.pct_of_costs !== null ? formatPercent(s.row.pct_of_costs) : "—"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
