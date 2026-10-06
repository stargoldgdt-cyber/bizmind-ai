import { MarketplaceBadge } from "@/features/overview/components/sections"
import { formatMoney, formatNumber } from "@/lib/format"
import { compareMoney } from "@/services/analytics/money"
import type { AnalysisOrder } from "@/services/catalog/product-analysis"

const NAME: Record<string, string> = { AMAZON: "Amazon", NOON: "noon", CARREFOUR: "Carrefour" }
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })

/**
 * The latest orders of this product in the chosen month, with what each one
 * earned. An order's profit is worked out in SQL and is "Incomplete" while any
 * unit in it has no cost. Order numbers are the marketplace's own; no customer
 * details are stored anywhere.
 */
export function OrdersTable({ rows, currency }: { rows: AnalysisOrder[]; currency: string }) {
  if (rows.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">No orders in this period.</p>
  }
  const th = "border-b border-border px-3 py-2.5 font-semibold"
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead className="bg-muted/30 text-[11px] tracking-wide text-muted-foreground uppercase">
          <tr>
            <th scope="col" className={`${th} text-left`}>Date</th>
            <th scope="col" className={`${th} text-left`}>Marketplace</th>
            <th scope="col" className={`${th} text-left`}>Order</th>
            <th scope="col" className={`${th} text-right`}>Units</th>
            <th scope="col" className={`${th} text-right`}>Net sales</th>
            <th scope="col" className={`${th} text-right`}>Profit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const loss = row.profit !== null && compareMoney(row.profit, "0") < 0
            return (
              <tr key={`${row.marketplace_code}-${row.order_ref}`}>
                <td className="border-b border-border px-3 py-3 whitespace-nowrap">{DATE.format(new Date(row.posted_at))}</td>
                <td className="border-b border-border px-3 py-3">
                  <span className="flex items-center gap-2">
                    <MarketplaceBadge code={row.marketplace_code} />
                    {NAME[row.marketplace_code] ?? row.marketplace_code}
                  </span>
                </td>
                <td className="border-b border-border px-3 py-3 font-mono text-xs">{row.order_ref}</td>
                <td className="border-b border-border px-3 py-3 text-right font-mono tabular-nums">{formatNumber(row.units, 4)}</td>
                <td className="border-b border-border px-3 py-3 text-right font-mono whitespace-nowrap tabular-nums">{formatMoney(row.net_sales, currency)}</td>
                <td
                  className={`border-b border-border px-3 py-3 text-right font-mono whitespace-nowrap tabular-nums ${
                    loss ? "text-danger-strong" : row.profit === null ? "text-muted-foreground" : "text-success-strong"
                  }`}
                >
                  {row.profit === null ? <span className="font-sans">Incomplete</span> : formatMoney(row.profit, currency)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
