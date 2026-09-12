"use client"

import Link from "next/link"
import { useId, useState } from "react"

import { cn } from "cn"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import type { ChannelComparison } from "@/services/analytics"

/**
 * Where each channel sits: how much of the business it is, against how much
 * of each sale it keeps.
 *
 * THE QUESTION IT ANSWERS
 * -----------------------
 * "Which channel is big, and which one is actually worth it?" A channel high
 * and to the right earns well on a lot of the business. High and to the left
 * is a small channel worth growing. Low and to the right is the dangerous one:
 * most of the business, little of the profit.
 *
 * WHY THE X AXIS IS A SHARE, NOT THE AMOUNT
 * -----------------------------------------
 * The position is a share of revenue, computed in SQL, so nothing here divides
 * one money figure by another to find a pixel. The exact amounts are in the
 * tooltip and in the table below, where they belong. The ordering is identical
 * either way.
 *
 * CLICKING A CHANNEL FILTERS THE DASHBOARD. Each point is a link, so it works
 * with a keyboard, can be opened in a new tab, and needs no JavaScript to
 * navigate. The table underneath is the accessible alternative: the same rows,
 * the same figures, with the exact amounts.
 *
 * A channel whose margin could not be calculated is NOT plotted at zero — it
 * is listed beneath the chart as unplotted, because a point at 0% would read
 * as "earns nothing".
 */

/** Chart series colours from the design system, assigned in fixed order. */
const SERIES = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
]

const WIDTH = 760
const HEIGHT = 380
const PAD = { top: 24, right: 28, bottom: 48, left: 56 }
const PLOT_W = WIDTH - PAD.left - PAD.right
const PLOT_H = HEIGHT - PAD.top - PAD.bottom

type Plotted = {
  channel: ChannelComparison
  colour: string
  x: number
  y: number
  r: number
}

export function ChannelScatter({
  channels,
  currency,
  activeChannelId,
  hrefFor,
}: {
  channels: ChannelComparison[]
  currency: string
  activeChannelId: string | null
  hrefFor: (channelId: string | null) => string
}) {
  const titleId = useId()
  const [hovered, setHovered] = useState<string | null>(null)

  const plottable = channels.filter(
    (c) => c.revenue_share !== null && c.gross_margin !== null
  )
  const unplotted = channels.filter(
    (c) => c.revenue_share === null || c.gross_margin === null
  )

  if (plottable.length === 0) {
    return (
      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
        No channel has both a revenue share and a margin in this period, so
        there is nothing to plot yet.
      </p>
    )
  }

  // Axis bounds. Margin can be negative -- a channel selling at a loss belongs
  // on the chart, below the zero line, not clipped out of it.
  const margins = plottable.map((c) => Number(c.gross_margin))
  const shares = plottable.map((c) => Number(c.revenue_share))
  const maxShare = Math.max(...shares, 10)
  const maxMargin = Math.max(...margins, 10)
  const minMargin = Math.min(...margins, 0)
  const marginSpan = maxMargin - minMargin || 1

  const orders = plottable.map((c) => c.orders_count)
  const maxOrders = Math.max(...orders, 1)

  const points: Plotted[] = plottable.map((channel, index) => {
    const shareValue = Number(channel.revenue_share)
    const marginValue = Number(channel.gross_margin)
    // Area, not radius, carries the order count: doubling a radius quadruples
    // the ink, which would read as four times the orders.
    const scale = Math.sqrt(channel.orders_count / maxOrders)

    return {
      channel,
      colour: SERIES[index % SERIES.length],
      x: PAD.left + (shareValue / maxShare) * PLOT_W,
      y: PAD.top + PLOT_H - ((marginValue - minMargin) / marginSpan) * PLOT_H,
      r: 7 + scale * 15,
    }
  })

  const zeroLine =
    minMargin < 0 ? PAD.top + PLOT_H - ((0 - minMargin) / marginSpan) * PLOT_H : null

  const gridY = [0, 0.25, 0.5, 0.75, 1]
  const active = points.find((p) => p.channel.channel_id === hovered)

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>
          Each channel by its share of revenue and its gross margin. Point size
          is the number of orders.
        </title>

        {/* Grid: recessive, so the points carry the meaning. */}
        {gridY.map((step) => {
          const y = PAD.top + PLOT_H - step * PLOT_H
          const value = minMargin + step * marginSpan
          return (
            <g key={step}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y}
                y2={y}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 10}
                y={y + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {Math.round(value)}%
              </text>
            </g>
          )
        })}

        {zeroLine !== null && (
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={zeroLine}
            y2={zeroLine}
            stroke="var(--color-danger)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        )}

        {[0, 0.5, 1].map((step) => (
          <text
            key={step}
            x={PAD.left + step * PLOT_W}
            y={HEIGHT - 18}
            textAnchor={step === 0 ? "start" : step === 1 ? "end" : "middle"}
            className="fill-muted-foreground text-[11px] tabular-nums"
          >
            {Math.round(step * maxShare)}%
          </text>
        ))}

        <text
          x={PAD.left + PLOT_W / 2}
          y={HEIGHT - 2}
          textAnchor="middle"
          className="fill-muted-foreground text-[11px]"
        >
          Share of revenue
        </text>
        <text
          x={14}
          y={PAD.top + PLOT_H / 2}
          textAnchor="middle"
          transform={`rotate(-90 14 ${PAD.top + PLOT_H / 2})`}
          className="fill-muted-foreground text-[11px]"
        >
          Gross margin
        </text>

        {points.map((point) => {
          const id = point.channel.channel_id
          const isActive = id === activeChannelId
          const isHovered = id === hovered

          return (
            <Link
              key={point.channel.channel_id ?? "unattributed"}
              href={hrefFor(point.channel.channel_id)}
              aria-label={`${point.channel.channel_name}: ${formatPercent(
                point.channel.revenue_share
              )} of revenue, ${formatPercent(point.channel.gross_margin)} margin, ${formatNumber(
                point.channel.orders_count
              )} orders, revenue ${formatMoney(point.channel.revenue, currency)}. Filter the dashboard to this channel.`}
              onMouseEnter={() => setHovered(id)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(id)}
              onBlur={() => setHovered(null)}
              className="outline-none"
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={point.r}
                fill={point.colour}
                fillOpacity={isActive || isHovered ? 0.95 : 0.7}
                stroke="var(--color-card)"
                strokeWidth={2}
                className="cursor-pointer transition-[fill-opacity,r] duration-150"
              />
              {isActive && (
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={point.r + 5}
                  fill="none"
                  stroke={point.colour}
                  strokeWidth={1.5}
                />
              )}
              {points.length <= 6 && (
                <text
                  x={point.x}
                  y={point.y - point.r - 7}
                  textAnchor="middle"
                  className="pointer-events-none fill-foreground text-[11px] font-medium"
                >
                  {point.channel.channel_name}
                </text>
              )}
            </Link>
          )
        })}
      </svg>

      <figcaption className="sr-only">
        The table below lists the same channels with their exact figures.
      </figcaption>

      {/* The hover layer: exact figures, never only a position. */}
      <div
        className={cn(
          "mt-2 min-h-14 rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-sm transition-opacity",
          active ? "opacity-100" : "opacity-0"
        )}
        aria-hidden={!active}
      >
        {active && (
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <span className="font-medium">{active.channel.channel_name}</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              revenue {formatMoney(active.channel.revenue, currency)} ·{" "}
              {formatPercent(active.channel.revenue_share)} of the total
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              margin {formatPercent(active.channel.gross_margin)} · profit{" "}
              {formatMoney(active.channel.gross_profit, currency)}
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatNumber(active.channel.orders_count)} orders
            </span>
          </div>
        )}
      </div>

      {unplotted.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Not plotted:{" "}
          {unplotted.map((c) => c.channel_name).join(", ")} — no margin could be
          calculated, and a point at 0% would read as earning nothing.
        </p>
      )}
    </figure>
  )
}
