import { TriangleAlert } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import type { ProductPerformance } from "@/services/analytics"

/**
 * Per-product profitability.
 *
 * Products whose costs are incomplete carry a marker, because a product
 * showing a 90% margin because half its costs are missing is the single most
 * misleading row this table could produce.
 */
export function ProductTable({
  products,
  currency,
  limit = 15,
}: {
  products: ProductPerformance[]
  currency: string
  limit?: number
}) {
  if (products.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">
        No product lines in this period.
      </p>
    )
  }

  const shown = products.slice(0, limit)

  return (
    <div className="overflow-x-auto [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Units</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Fees (allocated)</TableHead>
            <TableHead className="text-right">Gross profit</TableHead>
            <TableHead className="text-right">Margin</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {shown.map((product) => {
            const coverage = product.cost_coverage === null ? null : Number(product.cost_coverage)
            const incomplete = coverage !== null && coverage < 100

            return (
              <TableRow key={product.sku}>
                <TableCell className="max-w-64">
                  <span className="block truncate font-medium">{product.product_name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {product.sku}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatNumber(product.units_sold, 2)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatMoney(product.revenue, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatMoney(product.cogs, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatMoney(product.fees_allocated, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs font-medium tabular-nums">
                  {formatMoney(product.gross_profit, currency)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  <span className="inline-flex items-center justify-end gap-1">
                    {incomplete && (
                      <TriangleAlert
                        className="size-3 text-warning-strong"
                        aria-label={`Only ${coverage}% of this product's sales have a recorded cost, so the margin is overstated`}
                      />
                    )}
                    {formatPercent(product.gross_margin)}
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      {products.length > limit && (
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          Showing the top {limit} of {products.length} products by revenue.
        </p>
      )}
    </div>
  )
}
