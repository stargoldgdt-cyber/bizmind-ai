"use client"

import { useState } from "react"

import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import type { AnalysisMonth } from "@/services/catalog/product-analysis"

/**
 * Twelve months of one product: net sales as bars and gross profit as a line,
 * on ONE axis (both are money, so nothing is dual-axis; the margin is in the
 * tooltip and the table).
 *
 * Every bar end and point arrives from product_analysis() on one 0-1000 scale,
 * so nothing here scales money. A month with no cost for some units has no
 * gross profit: the line breaks there and the tooltip says "Incomplete"
 * instead of showing a number. Series are in the legend and in a table view,
 * so identity never depends on colour alone.
 */

const W = 760
const H = 240
const PAD = { top: 14, right: 12, bottom: 28, left: 12 }
const PW = W - PAD.left - PAD.right
const PH = H - PAD.top - PAD.bottom
const SHORT = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" })
const LONG = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
const at = (month: string) => new Date(`${month}T00:00:00Z`)

export function ProductTrendChart({ months, currency }: { months: AnalysisMonth[]; currency: string }) {
  const [active, setActive] = useState<number | null>(null)

  if (months.length === 0 || !months.some((m) => m.has_lines)) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">No sales for this product in the last 12 months.</p>
  }

  const slot = PW / months.length
  const barWidth = Math.max(6, Math.min(30, slot * 0.55))
  const cx = (i: number) => PAD.left + slot * i + slot / 2
  const y = (v: number) => PAD.top + PH - (v / 1000) * PH
  const zero = y(months[0].zero_y)

  // Break the line wherever a month has no gross profit.
  const segments: { x: number; y: number }[][] = [[]]
  months.forEach((m, i) => {
    if (m.gross_profit_y === null) {
      segments.push([])
      return
    }
    segments[segments.length - 1].push({ x: cx(i), y: y(m.gross_profit_y) })
  })

  const shown = active === null ? null : months[active]

  return (
    <div className="px-5 py-4">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Net sales and gross profit by month for this product">
          <line x1={PAD.left} x2={W - PAD.right} y1={zero} y2={zero} stroke="var(--color-border)" />
          {months.map((m, i) => {
            const top = Math.min(y(m.net_sales_y), zero)
            const height = Math.max(Math.abs(y(m.net_sales_y) - zero), m.has_lines ? 2 : 0)
            return (
              <g key={m.month}>
                <rect
                  x={cx(i) - barWidth / 2}
                  y={top}
                  width={barWidth}
                  height={height}
                  rx={3}
                  fill="var(--color-chart-1)"
                  opacity={active === null || active === i ? 1 : 0.4}
                />
                <text x={cx(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {SHORT.format(at(m.month))}
                </text>
              </g>
            )
          })}
          {segments.map((points, index) =>
            points.length > 1 ? (
              <polyline
                key={index}
                points={points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke="var(--color-chart-2)"
                strokeWidth={2}
                strokeLinejoin="round"
              />
            ) : null
          )}
          {months.map((m, i) =>
            m.gross_profit_y === null ? null : (
              <circle key={m.month} cx={cx(i)} cy={y(m.gross_profit_y)} r={4} fill="var(--color-chart-2)" stroke="var(--color-card)" strokeWidth={2} />
            )
          )}
          {months.map((m, i) => (
            <rect
              key={`hit-${m.month}`}
              x={PAD.left + slot * i}
              y={PAD.top}
              width={slot}
              height={PH + PAD.bottom}
              fill="transparent"
              tabIndex={0}
              aria-label={`${LONG.format(at(m.month))}: net sales ${formatMoney(m.net_sales, currency)}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>

        {shown && active !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-52 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-xs shadow-sm"
            style={{ left: `${Math.min(Math.max((cx(active) / W) * 100, 14), 86)}%` }}
          >
            <p className="font-semibold">{LONG.format(at(shown.month))}</p>
            <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums">
              <dt className="text-muted-foreground">Net sales</dt>
              <dd className="font-mono">{formatMoney(shown.net_sales, currency)}</dd>
              <dt className="text-muted-foreground">Gross profit</dt>
              <dd className="font-mono">{shown.gross_profit === null ? "Incomplete" : formatMoney(shown.gross_profit, currency)}</dd>
              <dt className="text-muted-foreground">Margin</dt>
              <dd className="font-mono">{shown.margin === null ? "—" : formatPercent(shown.margin)}</dd>
              <dt className="text-muted-foreground">Units</dt>
              <dd className="font-mono">{formatNumber(shown.units, 4)}</dd>
            </dl>
          </div>
        )}
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-2">
          <span className="size-2.5 rounded-sm" style={{ background: "var(--color-chart-1)" }} aria-hidden />
          Net sales
        </li>
        <li className="flex items-center gap-2">
          <span className="h-0.5 w-4 rounded" style={{ background: "var(--color-chart-2)" }} aria-hidden />
          Gross profit
        </li>
      </ul>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-primary">View as a table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="border-b border-border py-1.5 pr-3 font-medium">Month</th>
                <th className="border-b border-border py-1.5 pr-3 text-right font-medium">Units</th>
                <th className="border-b border-border py-1.5 pr-3 text-right font-medium">Net sales</th>
                <th className="border-b border-border py-1.5 pr-3 text-right font-medium">Gross profit</th>
                <th className="border-b border-border py-1.5 text-right font-medium">Margin</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td className="border-b border-border py-1.5 pr-3">{LONG.format(at(m.month))}</td>
                  <td className="border-b border-border py-1.5 pr-3 text-right font-mono tabular-nums">{m.has_lines ? formatNumber(m.units, 4) : "—"}</td>
                  <td className="border-b border-border py-1.5 pr-3 text-right font-mono tabular-nums">{m.has_lines ? formatMoney(m.net_sales, currency) : "—"}</td>
                  <td className="border-b border-border py-1.5 pr-3 text-right font-mono tabular-nums">
                    {!m.has_lines ? "—" : m.gross_profit === null ? "Incomplete" : formatMoney(m.gross_profit, currency)}
                  </td>
                  <td className="border-b border-border py-1.5 text-right font-mono tabular-nums">{m.margin === null ? "—" : formatPercent(m.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
