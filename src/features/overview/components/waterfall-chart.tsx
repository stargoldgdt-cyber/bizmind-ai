"use client"

import { useState } from "react"

import { formatMoney } from "@/lib/format"
import type { WaterfallStep } from "@/features/overview/queries"

/**
 * Where the sales money goes: gross sales down to net profit.
 *
 * Every bar's start and end arrive from SQL on one 0-1000 scale
 * (dashboard_waterfall), so nothing here adds money up to place a bar. A total
 * that is not final is drawn hatched and labelled "not final"; a step the
 * ledger could not complete is labelled the same way. The exact amounts are in
 * the tooltip and under each bar.
 */

const HEIGHT = 260
const TOP = 28
const BOTTOM = 56
const PLOT = HEIGHT - TOP - BOTTOM
const SLOT = 72
const BAR = 40

const COLOUR = {
  TOTAL: "var(--color-chart-1)",
  UP: "var(--color-chart-2)",
  DOWN: "var(--color-chart-3)",
}

function isNegative(amount: string) {
  return amount.trim().startsWith("-")
}

export function WaterfallChart({ steps, currency }: { steps: WaterfallStep[]; currency: string }) {
  const [active, setActive] = useState<number | null>(null)
  if (steps.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">No marketplace figures for this month.</p>
  }

  const width = steps.length * SLOT + 24
  const y = (v: number) => TOP + PLOT - (v / 1000) * PLOT
  const zero = y(steps[0].zero_at)
  const shown = active === null ? null : steps.find((s) => s.step === active) ?? null

  return (
    <div className="relative">
      <div className="overflow-x-auto px-3">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="h-[260px] min-w-full"
          style={{ width: `${width}px` }}
          role="img"
          aria-label="Waterfall from gross sales to net profit"
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <pattern id="wf-not-final" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--color-chart-1)" opacity="0.18" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-chart-1)" strokeWidth="2.5" />
            </pattern>
          </defs>

          <line x1={12} x2={width - 12} y1={zero} y2={zero} stroke="var(--color-border)" strokeWidth={1} />

          {steps.map((s, i) => {
            const x = 12 + i * SLOT + (SLOT - BAR) / 2
            const top = y(s.bar_to)
            const h = Math.max(2, y(s.bar_from) - y(s.bar_to))
            const notFinal = s.status === "INCOMPLETE"
            const fill =
              s.kind === "TOTAL"
                ? notFinal
                  ? "url(#wf-not-final)"
                  : COLOUR.TOTAL
                : isNegative(s.amount)
                  ? COLOUR.DOWN
                  : COLOUR.UP
            const next = steps[i + 1]
            return (
              <g
                key={s.step}
                onMouseEnter={() => setActive(s.step)}
                onFocus={() => setActive(s.step)}
                tabIndex={0}
                role="listitem"
                aria-label={`${s.label}: ${formatMoney(s.amount, currency)}${notFinal ? ", not final" : ""}`}
                className="outline-none"
              >
                <rect x={x - 12} y={TOP} width={SLOT - 8} height={PLOT} fill="transparent" />
                <rect
                  x={x}
                  y={top}
                  width={BAR}
                  height={h}
                  rx={4}
                  fill={fill}
                  opacity={active === null || active === s.step ? 1 : 0.45}
                  stroke={active === s.step ? "var(--color-foreground)" : "none"}
                  strokeWidth={1}
                />
                {next && (
                  <line
                    x1={x + BAR}
                    x2={x + SLOT}
                    y1={isNegative(s.amount) && s.kind === "DELTA" ? top + h : top}
                    y2={isNegative(s.amount) && s.kind === "DELTA" ? top + h : top}
                    stroke="var(--color-border)"
                    strokeDasharray="2 3"
                  />
                )}
                <text x={x + BAR / 2} y={top - 6} textAnchor="middle" className="fill-foreground font-mono text-[10px] tabular-nums">
                  {formatMoney(s.amount, currency, { compact: true })}
                </text>
                <text x={x + BAR / 2} y={HEIGHT - 34} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {s.label.length > 12 ? `${s.label.slice(0, 11)}…` : s.label}
                </text>
                {notFinal && (
                  <text x={x + BAR / 2} y={HEIGHT - 20} textAnchor="middle" className="fill-warning-strong text-[9px] font-semibold">
                    not final
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {shown && (
        <div className="pointer-events-none absolute right-4 top-2 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-sm">
          <p className="font-medium">{shown.label}</p>
          <p className="font-mono tabular-nums">{formatMoney(shown.amount, currency)}</p>
          {shown.status === "INCOMPLETE" && <p className="text-warning-strong">Not final — see what needs attention</p>}
        </div>
      )}

      <ul className="flex flex-wrap gap-x-5 gap-y-1 px-5 pb-4 text-xs text-muted-foreground">
        <Legend colour={COLOUR.TOTAL} label="Total" />
        <Legend colour={COLOUR.UP} label="Money added" />
        <Legend colour={COLOUR.DOWN} label="Money taken" />
        <li className="inline-flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden>
            <rect width="12" height="12" rx="2" fill="url(#wf-not-final)" />
          </svg>
          Total not final
        </li>
      </ul>
    </div>
  )
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span className="inline-block size-3 rounded-sm" style={{ background: colour }} aria-hidden />
      {label}
    </li>
  )
}
