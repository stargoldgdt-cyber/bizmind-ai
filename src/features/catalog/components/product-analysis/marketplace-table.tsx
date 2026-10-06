import { MarketplaceBadge } from "@/features/overview/components/sections"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import type { AnalysisMarketplace, AnalysisPeriod } from "@/services/catalog/product-analysis"

const NAME: Record<string, string> = { AMAZON: "Amazon", NOON: "noon", CARREFOUR: "Carrefour" }

/**
 * The product, marketplace by marketplace, for the chosen month. Every row and
 * the total come from SQL (the total is the same figure as the header cards),
 * so nothing is added up here. Costs and gross profit that cannot be final
 * read "Incomplete", never a number.
 */
export function MarketplaceTable({
  rows,
  total,
  currency,
}: {
  rows: AnalysisMarketplace[]
  total: AnalysisPeriod | null
  currency: string
}) {
  if (rows.length === 0) {
    return <p className="px-5 py-10 text-center text-sm text-muted-foreground">No sales in this period.</p>
  }
  const th = "border-b border-border px-3 py-2.5 font-semibold"
  const td = "border-b border-border px-3 py-3 text-right font-mono tabular-nums whitespace-nowrap"
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <thead className="bg-muted/30 text-[11px] tracking-wide text-muted-foreground uppercase">
          <tr>
            <th scope="col" className={`${th} text-left`}>Marketplace</th>
            <th scope="col" className={`${th} text-right`}>Units</th>
            <th scope="col" className={`${th} text-right`}>Net sales</th>
            <th scope="col" className={`${th} text-right`}>Marketplace costs</th>
            <th scope="col" className={`${th} text-right`}>Cost of goods</th>
            <th scope="col" className={`${th} text-right`}>Gross profit</th>
            <th scope="col" className={`${th} text-right`}>Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.account_id}>
              <td className="border-b border-border px-3 py-3">
                <span className="flex items-center gap-2.5">
                  <MarketplaceBadge code={row.marketplace_code} />
                  <span>
                    <span className="font-medium">{NAME[row.marketplace_code] ?? row.marketplace_code}</span>
                    {rows.length > 1 && <span className="block text-xs text-muted-foreground">{row.account_label}</span>}
                  </span>
                </span>
              </td>
              <td className={td}>{formatNumber(row.units, 4)}</td>
              <td className={td}>{formatMoney(row.net_sales, currency)}</td>
              <td className={`${td} text-muted-foreground`}>{formatMoney(row.costs, currency)}</td>
              <td className={td}>{row.cogs === null ? <span className="font-sans text-muted-foreground">Incomplete</span> : formatMoney(row.cogs, currency)}</td>
              <td className={`${td} font-semibold`}>
                {row.gross_profit === null ? <span className="font-sans font-medium text-muted-foreground">Incomplete</span> : formatMoney(row.gross_profit, currency)}
              </td>
              <td className={td}>{row.margin === null ? "—" : formatPercent(row.margin)}</td>
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot className="bg-muted/30 font-semibold">
            <tr>
              <th scope="row" className="px-3 py-3 text-left">Total</th>
              <td className="px-3 py-3 text-right font-mono tabular-nums">{formatNumber(total.units, 4)}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums">{formatMoney(total.net_sales, currency)}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums">{formatMoney(total.costs, currency)}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums">
                {total.cogs === null ? <span className="font-sans">Incomplete</span> : formatMoney(total.cogs, currency)}
              </td>
              <td className="px-3 py-3 text-right font-mono tabular-nums">
                {total.gross_profit === null ? <span className="font-sans">Incomplete</span> : formatMoney(total.gross_profit, currency)}
              </td>
              <td className="px-3 py-3 text-right font-mono tabular-nums">{total.margin === null ? "—" : formatPercent(total.margin)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
