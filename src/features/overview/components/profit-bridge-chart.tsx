"use client"

import { useState } from "react"

import { formatMoney } from "@/lib/format"
import type { BridgeStep } from "@/features/overview/queries"

/**
 * Why contribution changed since the period before: previous contribution,
 * each line's own dollar move, current contribution.
 *
 * Every bar's position arrives from SQL on one 0-1000 scale
 * (dashboard_profit_bridge, migration 0060), the same way the waterfall does
 * -- nothing here adds money up to place a bar. A step that moved profit up
 * is drawn in the success colour, one that moved it down in danger, matching
 * the arrow-and-word convention the KPI cards already use (colour is never
 * the only signal). Start and end totals are violet, like the waterfall's
 * own totals.
 */

const HEIGHT = 260
const TOP = 28
const BOTTOM = 56
const PLOT = HEIGHT - TOP - BOTTOM
const SLOT = 84
const BAR = 44

const COLOUR = {
  TOTAL: "var(--color-chart-1)",
  UP: "var(--color-success)",
  DOWN: "var(--color-danger)",
}

function isNegative(amount: string) {
  return amount.trim().startsWith("-")
}

export function ProfitBridgeChart({ steps, currency }: { steps: BridgeStep[]; currency: string }) {
  const [active, setActive] = useState<number | null>(null)
  if (steps.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">Not enough history to compare yet.</p>
  }

  const width = steps.length * SLOT + 24
  const y = (v: number) => TOP + PLOT - (v / 1000) * PLOT
  const zero = y(steps[0].zero_at)
  const shown = active === null ? null : (steps.find((s) => s.step === active) ?? null)

  return (
    <div className="relative">
      <div className="overflow-x-auto px-3">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="h-[260px] min-w-full"
          style={{ width: `${width}px` }}
          role="img"
          aria-label="Bridge from previous contribution to current contribution"
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <pattern id="bridge-not-final" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
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
              s.kind !== "DELTA"
                ? notFinal
                  ? "url(#bridge-not-final)"
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
                <rect x={x - 14} y={TOP} width={SLOT - 8} height={PLOT} fill="transparent" />
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
                  {s.label.length > 13 ? `${s.label.slice(0, 12)}…` : s.label}
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
        <div className="pointer-events-none absolute top-2 right-4 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-sm">
          <p className="font-medium">{shown.label}</p>
          <p className="font-mono tabular-nums">{formatMoney(shown.amount, currency)}</p>
          {shown.status === "INCOMPLETE" && <p className="text-warning-strong">Not final — see what needs attention</p>}
        </div>
      )}

      <ul className="flex flex-wrap gap-x-5 gap-y-1 px-5 pb-4 text-xs text-muted-foreground">
        <Legend colour={COLOUR.TOTAL} label="Total" />
        <Legend colour={COLOUR.UP} label="Helped profit" />
        <Legend colour={COLOUR.DOWN} label="Hurt profit" />
        <li className="inline-flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden>
            <rect width="12" height="12" rx="2" fill="url(#bridge-not-final)" />
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
