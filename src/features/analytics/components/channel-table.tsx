import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { getSeriesColor } from "@/config/design-tokens"
import type { ChannelPerformance } from "@/services/analytics"

/**
 * Revenue and margin per sales channel.
 *
 * This is the product's signature insight — the table that shows a channel can
 * bring in the most revenue while earning the least profit. It only works
 * because fees are tracked per order rather than lumped into expenses.
 *
 * The coloured dot follows the CHANNEL, not its rank, so re-sorting or
 * filtering never repaints a channel a different colour. Identity is carried
 * by the name; the dot is a secondary cue for when charts arrive in Phase 7.
 */
export function ChannelTable({
  channels,
  currency,
}: {
  channels: ChannelPerformance[]
  currency: string
}) {
  if (channels.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">
        No sales in this period, so there is nothing to compare yet.
      </p>
    )
  }

  // Stable colour assignment, capped at the validated palette size.
  const colourFor = (index: number) =>
    index < 6 ? getSeriesColor(index) : "var(--muted-foreground)"

  return (
    // Full-bleed horizontal scroll so a wide table can be swiped on mobile,
    // with the outer cells padded back to the card's own inset so nothing sits
    // flush against the border.
    <div className="overflow-x-auto [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Channel</TableHead>
            <TableHead className="text-right">Orders</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Fees</TableHead>
            <TableHead className="text-right">Gross profit</TableHead>
            <TableHead className="text-right">Margin</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {channels.map((channel, index) => (
            <TableRow key={channel.channel_id ?? `unattributed-${index}`}>
              <TableCell className="font-medium">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: colourFor(index) }}
                  />
                  {channel.channel_name}
                </span>
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {formatNumber(channel.orders_count)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {formatMoney(channel.revenue, currency)}
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
                {formatPercent(channel.gross_margin)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
