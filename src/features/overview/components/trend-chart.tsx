"use client"

import { useState } from "react"

import { formatMoney } from "@/lib/format"
import type { DailyPoint } from "@/features/overview/queries"

/**
 * Day by day: gross sales, net sales and contribution.
 *
 * One y-axis: all three series share the 0-1000 scale SQL returned
 * (dashboard_daily), so nothing here scales money. Contribution is drawn
 * dashed and labelled "so far" while the month's contribution is not final.
 * Hovering (or focusing) a day shows its exact figures.
 */

const W = 760
const H = 240
const PAD = { top: 16, right: 16, bottom: 28, left: 16 }
const PW = W - PAD.left - PAD.right
const PH = H - PAD.top - PAD.bottom

const SERIES = [
  { key: "gross", label: "Gross sales", colour: "var(--color-chart-1)" },
  { key: "net", label: "Net sales", colour: "var(--color-chart-4)" },
  { key: "contribution", label: "Contribution", colour: "var(--color-chart-2)" },
] as const

export function TrendChart({
  points,
  currency,
  contributionFinal,
}: {
  points: DailyPoint[]
  currency: string
  contributionFinal: boolean
}) {
  const [active, setActive] = useState<number | null>(null)
  if (points.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">No days to show.</p>
  }

  const x = (i: number) => PAD.left + (points.length === 1 ? PW / 2 : (i / (points.length - 1)) * PW)
  const y = (v: number) => PAD.top + PH - (v / 1000) * PH
  const path = (pick: (p: DailyPoint) => number) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ")
  const lines = {
    gross: path((p) => p.gross_y),
    net: path((p) => p.net_y),
    contribution: path((p) => p.contribution_y),
  }
  const zero = y(points[0].zero_y)
  const shown = active === null ? null : points[active]
  const tick = (i: number) => i === 0 || i === points.length - 1 || (i + 1) % 7 === 0

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Daily gross sales, net sales and contribution"
        onMouseLeave={() => setActive(null)}
      >
        <line x1={PAD.left} x2={W - PAD.right} y1={zero} y2={zero} stroke="var(--color-border)" />
        {SERIES.map((s) => (
          <path
            key={s.key}
            d={lines[s.key]}
            fill="none"
            stroke={s.colour}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeDasharray={s.key === "contribution" && !contributionFinal ? "5 4" : undefined}
          />
        ))}
        {active !== null && (
          <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--color-muted-foreground)" strokeDasharray="3 3" />
        )}
        {active !== null &&
          SERIES.map((s) => {
            const p = points[active]
            const v = s.key === "gross" ? p.gross_y : s.key === "net" ? p.net_y : p.contribution_y
            return <circle key={s.key} cx={x(active)} cy={y(v)} r={4} fill="var(--color-card)" stroke={s.colour} strokeWidth={2} />
          })}
        {points.map((p, i) => (
          <g key={p.day}>
            <rect
              x={x(i) - PW / points.length / 2}
              y={PAD.top}
              width={PW / points.length}
              height={PH}
              fill="transparent"
              tabIndex={0}
              aria-label={`${p.day}: gross ${formatMoney(p.gross_sales, currency)}, net ${formatMoney(p.net_sales, currency)}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
            />
            {tick(i) && (
              <text x={x(i)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[13px]">
                {Number(p.day.slice(8, 10))}
              </text>
            )}
          </g>
        ))}
      </svg>

      {shown && (
        <div className="pointer-events-none absolute right-4 top-2 min-w-48 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-sm">
          <p className="font-medium">{shown.day}</p>
          {!shown.has_lines && <p className="text-muted-foreground">Nothing reported this day</p>}
          <Row label="Gross sales" value={formatMoney(shown.gross_sales, currency)} colour={SERIES[0].colour} />
          <Row label="Net sales" value={formatMoney(shown.net_sales, currency)} colour={SERIES[1].colour} />
          <Row
            label={contributionFinal ? "Contribution" : "Contribution so far"}
            value={formatMoney(shown.contribution, currency)}
            colour={SERIES[2].colour}
          />
        </div>
      )}

      <ul className="flex flex-wrap gap-x-5 gap-y-1 px-1 pt-2 text-xs text-muted-foreground">
        {SERIES.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden>
              <line
                x1="0"
                x2="18"
                y1="3"
                y2="3"
                stroke={s.colour}
                strokeWidth="2"
                strokeDasharray={s.key === "contribution" && !contributionFinal ? "5 4" : undefined}
              />
            </svg>
            {s.key === "contribution" && !contributionFinal ? "Contribution (so far, not final)" : s.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Row({ label, value, colour }: { label: string; value: string; colour: string }) {
  return (
    <p className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className="inline-block size-2 rounded-full" style={{ background: colour }} aria-hidden />
        {label}
      </span>
      <span className="font-mono tabular-nums">{value}</span>
    </p>
  )
}
