"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { CircleAlert, TrendingUp } from "lucide-react"

import { Card } from "@/features/overview/components/sections"
import { StatusLabel } from "@/features/ledger/components/status-label"
import type { ProductRow } from "@/features/overview/queries"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { compareMoney } from "@/services/analytics/money"

/**
 * Product profitability, grouped into three tabs by an already-final margin
 * figure. This buckets an existing, already-computed number -- it is display
 * grouping, not a new calculation, and it never converts the exact-decimal
 * margin to a number: `compareMoney` orders the digits directly (same rule
 * as everywhere else money-shaped text is compared).
 *
 * A product whose cost is not fully known yet (`cogs_status !== "COSTED"`)
 * has no final margin to bucket by, so it stays out of all three tabs --
 * exactly as it was excluded from the single list before this.
 */

const TAB = {
  best: { label: "Best Performers", icon: "text-success-strong" },
  watch: { label: "Watch (Low Margin)", icon: "text-warning-strong" },
  losing: { label: "Losing Money", icon: "text-danger-strong" },
} as const
type TabKey = keyof typeof TAB

export function bucketOf(row: ProductRow): TabKey | null {
  if (row.cogs_status !== "COSTED" || row.gross_margin_percent === null) return null
  if (compareMoney(row.gross_margin_percent, "0") < 0) return "losing"
  if (compareMoney(row.gross_margin_percent, "15") < 0) return "watch"
  return "best"
}

export function ProductsTable({ rows, currency, href }: { rows: ProductRow[]; currency: string; href: string }) {
  const [tab, setTab] = useState<TabKey>("best")
  const money = (v: string | null | undefined) => formatMoney(v, currency)

  const buckets = useMemo(() => {
    const out: Record<TabKey, ProductRow[]> = { best: [], watch: [], losing: [] }
    for (const row of rows) {
      const bucket = bucketOf(row)
      if (bucket) out[bucket].push(row)
    }
    return out
  }, [rows])
  const uncosted = rows.filter((r) => bucketOf(r) === null)
  const shown = buckets[tab]

  return (
    <Card
      title="Product profitability"
      description="Your best sellers in this period, including SKUs not yet matched to a product. Marketplace-level fees and advertising are not split across products."
      icon={TrendingUp}
    >
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">No product sales in this period.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 px-5 pt-4">
            {(Object.keys(TAB) as TabKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={
                  tab === key
                    ? "rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary"
                    : "rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }
              >
                {TAB[key].label} ({buckets[key].length})
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              {uncosted.length > 0
                ? `No products in this group yet. ${formatNumber(uncosted.length)} product${uncosted.length === 1 ? " has" : "s have"} no final cost yet, so they can't be grouped by margin.`
                : "No products in this group."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] whitespace-nowrap text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-2 font-semibold">Product</th>
                    <th className="px-3 py-2 text-right font-semibold">Units</th>
                    <th className="px-3 py-2 text-right font-semibold">Net sales</th>
                    <th className="px-3 py-2 text-right font-semibold">Cost of goods</th>
                    <th className="px-3 py-2 text-right font-semibold">Gross profit</th>
                    <th className="px-5 py-2 text-right font-semibold">Margin</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map((p) => (
                    <tr key={`${p.row_kind}-${p.product_id ?? p.raw_sku}-${p.marketplace_code ?? ""}`}>
                      <td className="min-w-52 whitespace-normal px-5 py-3">
                        <span className="font-medium">{p.product_name ?? p.raw_sku}</span>
                        {p.product_category && <span className="block text-[11px] text-muted-foreground">{p.product_category}</span>}
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{formatNumber(p.units_sold, 4)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{money(p.net_sales)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">{p.cogs === null ? "—" : money(p.cogs)}</td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">
                        {p.gross_profit === null ? <StatusLabel status="INCOMPLETE" /> : money(p.gross_profit)}
                      </td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums">{formatPercent(p.gross_margin_percent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {uncosted.length > 0 && (
            <p className="flex items-center gap-1.5 border-t border-border px-5 py-2.5 text-xs text-warning-strong">
              <CircleAlert className="size-3.5 shrink-0" aria-hidden />
              {formatNumber(uncosted.length)} product{uncosted.length === 1 ? "" : "s"} not shown above: no final cost yet, or no SKU
              match, so margin can&apos;t be worked out.
            </p>
          )}
        </>
      )}
      <Link href={href} className="border-t border-border px-5 py-2.5 text-xs font-medium underline-offset-4 hover:underline">
        All products, unmatched SKUs and costs
      </Link>
    </Card>
  )
}
