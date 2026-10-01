"use client"

import { useState } from "react"

import { formatMoney } from "@/lib/format"
import type { MonthlyPoint } from "@/features/overview/queries"

/**
 * Month by month: net sales per marketplace account (bars) and the business's
 * contribution (a line), on one axis.
 *
 * Every bar end and line point arrives from SQL on one 0-1000 scale
 * (dashboard_monthly, 0049), so nothing here scales money. A month whose
 * contribution is not final is drawn dashed and says so in the tooltip and the
 * table. Colour follows the account, never its rank, and every series is in
 * the legend, so identity is never colour alone.
 */

const W = 760
const H = 260
const PAD = { top: 16, right: 12, bottom: 30, left: 12 }
const PW = W - PAD.left - PAD.right
const PH = H - PAD.top - PAD.bottom
const COLOURS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
  "var(--color-chart-4)",
  "var(--color-chart-3)",
]
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" })
const MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })

export function MonthlyTrend({ points, currency }: { points: MonthlyPoint[]; currency: string }) {
  const [active, setActive] = useState<number | null>(null)

  const months = [...new Set(points.map((p) => p.month))]
  const accounts = [...new Map(points.map((p) => [p.marketplace_account_id, p.account_label])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, label], index) => ({ id, label, colour: COLOURS[index % COLOURS.length] }))
  if (months.length === 0 || !points.some((p) => p.has_lines)) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">No months with marketplace figures yet.</p>
  }

  const at = (month: string, account: string) =>
    points.find((p) => p.month === month && p.marketplace_account_id === account)
  const monthRow = (month: string) => points.find((p) => p.month === month)!
  const slot = PW / months.length
  const barWidth = Math.max(4, Math.min(28, (slot * 0.7) / accounts.length))
  const cx = (i: number) => PAD.left + slot * i + slot / 2
  const y = (v: number) => PAD.top + PH - (v / 1000) * PH
  const zero = y(points[0].zero_y)
  const shown = active === null ? null : months[active]
  const label = (m: string) => MONTH.format(new Date(`${m}T00:00:00Z`))

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Net sales per marketplace and contribution, month by month"
        onMouseLeave={() => setActive(null)}
      >
        <line x1={PAD.left} x2={W - PAD.right} y1={zero} y2={zero} stroke="var(--color-border)" />

        {months.map((m, i) => (
          <g key={m}>
            {active === i && (
              <rect x={cx(i) - slot / 2} y={PAD.top} width={slot} height={PH} fill="var(--color-muted)" opacity={0.6} />
            )}
            {accounts.map((a, j) => {
              const p = at(m, a.id)
              if (!p) return null
              const x = cx(i) - (barWidth * accounts.length) / 2 + j * barWidth
              return (
                <rect
                  key={a.id}
                  x={x + 1}
                  y={y(p.bar_to)}
                  width={barWidth - 2}
                  height={Math.max(p.has_lines ? 1 : 0, y(p.bar_from) - y(p.bar_to))}
                  rx={2}
                  fill={a.colour}
                />
              )
            })}
            <text x={cx(i)} y={H - 10} textAnchor="middle" className="fill-muted-foreground text-[12px]">
              {label(m)}
            </text>
            <rect
              x={cx(i) - slot / 2}
              y={PAD.top}
              width={slot}
              height={PH}
              fill="transparent"
              tabIndex={0}
              aria-label={`${MONTH_YEAR.format(new Date(`${m}T00:00:00Z`))}: net sales ${formatMoney(monthRow(m).month_net_sales, currency)}, contribution ${formatMoney(monthRow(m).month_contribution, currency)}${monthRow(m).month_status === "INCOMPLETE" ? ", not final" : ""}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
            />
          </g>
        ))}

        {/* Contribution: dashed into and out of a month that is not final. */}
        {months.slice(1).map((m, k) => {
          const i = k + 1
          const a = monthRow(months[i - 1])
          const b = monthRow(m)
          const notFinal = a.month_status === "INCOMPLETE" || b.month_status === "INCOMPLETE"
          return (
            <line
              key={m}
              x1={cx(i - 1)}
              x2={cx(i)}
              y1={y(a.month_contribution_y)}
              y2={y(b.month_contribution_y)}
              stroke="var(--color-foreground)"
              strokeWidth={2}
              strokeDasharray={notFinal ? "5 4" : undefined}
            />
          )
        })}
        {months.map((m, i) => (
          <circle
            key={m}
            cx={cx(i)}
            cy={y(monthRow(m).month_contribution_y)}
            r={active === i ? 5 : 3.5}
            fill="var(--color-card)"
            stroke="var(--color-foreground)"
            strokeWidth={2}
          />
        ))}
      </svg>

      {shown && (
        <div className="pointer-events-none absolute right-3 top-2 min-w-56 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-sm">
          <p className="font-medium">{MONTH_YEAR.format(new Date(`${shown}T00:00:00Z`))}</p>
          {accounts.map((a) => (
            <Row key={a.id} label={a.label} value={formatMoney(at(shown, a.id)?.net_sales, currency)} colour={a.colour} />
          ))}
          <Row label="Net sales, all" value={formatMoney(monthRow(shown).month_net_sales, currency)} />
          <Row
            label={monthRow(shown).month_status === "INCOMPLETE" ? "Contribution so far (not final)" : "Contribution"}
            value={formatMoney(monthRow(shown).month_contribution, currency)}
          />
        </div>
      )}

      <ul className="flex flex-wrap gap-x-5 gap-y-1 px-1 pt-2 text-xs text-muted-foreground">
        {accounts.map((a) => (
          <li key={a.id} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-sm" style={{ background: a.colour }} aria-hidden />
            {a.label} · net sales
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <svg width="20" height="6" aria-hidden>
            <line x1="0" x2="20" y1="3" y2="3" stroke="var(--color-foreground)" strokeWidth="2" />
          </svg>
          Contribution (dashed: not final)
        </li>
      </ul>

      <details className="mt-3 px-1 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
          Show as a table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[520px] whitespace-nowrap text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Month</th>
                {accounts.map((a) => (
                  <th key={a.id} className="px-3 py-1.5 text-right font-medium">
                    {a.label}
                  </th>
                ))}
                <th className="px-3 py-1.5 text-right font-medium">Net sales</th>
                <th className="py-1.5 pl-3 text-right font-medium">Contribution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {months.map((m) => (
                <tr key={m}>
                  <td className="py-1.5 pr-3">{MONTH_YEAR.format(new Date(`${m}T00:00:00Z`))}</td>
                  {accounts.map((a) => (
                    <td key={a.id} className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {formatMoney(at(m, a.id)?.net_sales, currency)}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {formatMoney(monthRow(m).month_net_sales, currency)}
                  </td>
                  <td className="py-1.5 pl-3 text-right font-mono tabular-nums">
                    {formatMoney(monthRow(m).month_contribution, currency)}
                    {monthRow(m).month_status === "INCOMPLETE" && (
                      <span className="ml-1 font-sans text-[10px] text-warning-strong">not final</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function Row({ label, value, colour }: { label: string; value: string; colour?: string }) {
  return (
    <p className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        {colour && <span className="inline-block size-2 rounded-full" style={{ background: colour }} aria-hidden />}
        {label}
      </span>
      <span className="font-mono tabular-nums">{value}</span>
    </p>
  )
}
