import Link from "next/link"
import { TriangleAlert } from "lucide-react"

import { cn } from "cn"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import type { ChannelComparison } from "@/services/analytics"

import { DeltaChip } from "./delta-chip"

/**
 * Every channel, with what it is worth and which way it is going.
 *
 * Revenue says where the business is busy; margin says where it is paid; the
 * contribution column says how much of the profit actually came from here.
 * They are frequently three different answers, and the whole point of the
 * section is that an owner can see all three at once.
 *
 * A row is a link: clicking a channel filters the entire dashboard to it.
 *
 * NOTHING IS CALCULATED HERE. Shares, changes and margin movements all arrive
 * computed from `analytics_channel_compare()`.
 */
export function ChannelIntelligence({
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
  if (channels.length === 0) {
    return (
      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
        No channel activity in this period.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Channel</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right">Share</TableHead>
            <TableHead className="text-right">vs previous</TableHead>
            <TableHead className="text-right">Orders</TableHead>
            <TableHead className="text-right">Units</TableHead>
            <TableHead className="text-right">Avg order</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Fees</TableHead>
            <TableHead className="text-right">Gross profit</TableHead>
            <TableHead className="text-right">Margin</TableHead>
            <TableHead className="text-right">Of total profit</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {channels.map((channel) => {
            const costCoverage =
              channel.cost_coverage === null ? null : Number(channel.cost_coverage)
            const feeCoverage =
              channel.fee_coverage === null ? null : Number(channel.fee_coverage)
            const incomplete =
              (costCoverage !== null && costCoverage < 100) ||
              (feeCoverage !== null && feeCoverage < 100)
            const selected = channel.channel_id === activeChannelId

            return (
              <TableRow
                key={channel.channel_id ?? "unattributed"}
                className={cn(selected && "bg-accent/50")}
              >
                <TableCell className="max-w-52">
                  <Link
                    href={hrefFor(channel.channel_id)}
                    className="block truncate font-medium underline-offset-4 hover:underline"
                    aria-label={`Filter the dashboard to ${channel.channel_name}`}
                  >
                    {channel.channel_name}
                  </Link>
                  {channel.direction === "new" && (
                    <span className="text-[11px] text-muted-foreground">
                      New this period
                    </span>
                  )}
                </TableCell>

                <TableCell className="text-right font-mono text-xs font-medium tabular-nums">
                  {formatMoney(channel.revenue, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatPercent(channel.revenue_share)}
                </TableCell>

                <TableCell className="text-right">
                  {channel.revenue_change_pct === null ? (
                    <span className="font-mono text-xs text-muted-foreground">—</span>
                  ) : (
                    <DeltaChip change={Number(channel.revenue_change_pct)} />
                  )}
                </TableCell>

                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatNumber(channel.orders_count)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatNumber(channel.units_sold, 2)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatMoney(channel.avg_order_value, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatMoney(channel.cogs, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatMoney(channel.fees, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs font-medium tabular-nums">
                  {formatMoney(channel.gross_profit, currency)}
                </TableCell>

                <TableCell className="text-right font-mono text-xs tabular-nums">
                  <span className="inline-flex items-center justify-end gap-1">
                    {incomplete && (
                      <TriangleAlert
                        className="size-3 text-warning-strong"
                        aria-label={`Costs recorded on ${formatPercent(
                          channel.cost_coverage
                        )} of lines and fees on ${formatPercent(
                          channel.fee_coverage
                        )} of orders, so this margin is higher than reality`}
                      />
                    )}
                    {formatPercent(channel.gross_margin)}
                    {channel.margin_change_pts !== null && (
                      <span
                        className="text-[11px] text-muted-foreground"
                        title="Change against the previous period, in percentage points"
                      >
                        {Number(channel.margin_change_pts) > 0 ? "+" : ""}
                        {channel.margin_change_pts} pts
                      </span>
                    )}
                  </span>
                </TableCell>

                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatPercent(channel.profit_share)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      <p className="px-4 pt-3 text-xs text-muted-foreground">
        Share is of this period&apos;s revenue; &ldquo;of total profit&rdquo; is
        of the gross profit the business actually made. When it made none, that
        column is blank rather than a percentage of a loss. Margin changes are
        shown in percentage points.
      </p>
    </div>
  )
}
