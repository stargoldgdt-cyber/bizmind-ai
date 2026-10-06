import Link from "next/link"
import { ArrowDown, ArrowUp, CircleCheck, type LucideIcon } from "lucide-react"

import { formatMoney, formatNumber } from "@/lib/format"
import { compareMoney } from "@/services/analytics/money"
import type { ProfitViewRow } from "@/services/catalog/product-profit-view"

import { MarginChip } from "./margin-chip"
import { ProductThumb } from "./product-thumb"

/**
 * A short ranked list: the products that made the most, or lost the most.
 * The order comes from comparing the exact figures; none is recalculated.
 * The sign is part of the number, so colour is never the only signal.
 */
export function RankedCard({
  title,
  tone,
  rows,
  currency,
  empty,
}: {
  title: string
  tone: "success" | "danger"
  rows: ProfitViewRow[]
  currency: string
  empty: string
}) {
  const Icon: LucideIcon = tone === "success" ? ArrowUp : ArrowDown
  const iconStyle = tone === "success" ? "bg-success-subtle text-success-strong" : "bg-danger-subtle text-danger-strong"

  return (
    <section className="@container flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-3 px-5 pt-5">
        <div className="flex items-center gap-3">
          <span className={`flex size-8 items-center justify-center rounded-full ${iconStyle}`} aria-hidden>
            <Icon className="size-4" />
          </span>
          <h2 className="text-base font-semibold">{title}</h2>
        </div>
        <Link href="#all-products" className="text-sm font-medium text-primary hover:underline">
          View all
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-10 text-center">
          {tone === "danger" && <CircleCheck className="size-6 text-success-strong" aria-hidden />}
          <p className="text-sm text-muted-foreground">{empty}</p>
        </div>
      ) : (
        <div className="overflow-x-auto px-5 pt-3 pb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] tracking-wide text-muted-foreground uppercase">
                <th className="w-6 py-2 font-semibold">#</th>
                <th className="min-w-36 py-2 font-semibold">Product</th>
                <th className="hidden px-2 py-2 text-right font-semibold @xl:table-cell">Units</th>
                <th className="hidden px-2 py-2 text-right font-semibold @xl:table-cell">Net sales</th>
                <th className="px-2 py-2 text-right font-semibold">Gross profit</th>
                <th className="py-2 pl-2 text-right font-semibold">Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row, index) => {
                const negative = row.grossProfit !== null && compareMoney(row.grossProfit, "0") < 0
                return (
                  <tr key={row.key}>
                    <td className="py-3">
                      <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground tabular-nums">
                        {index + 1}
                      </span>
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-3">
                        <ProductThumb />
                        <div className="min-w-0">
                          {row.productId ? (
                            <Link href={`/catalog/products/${row.productId}`} className="font-medium hover:underline">
                              {row.name}
                            </Link>
                          ) : (
                            <span className="font-medium">{row.name}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="hidden px-2 py-3 text-right font-mono tabular-nums @xl:table-cell">{formatNumber(row.units, 4)}</td>
                    <td className="hidden px-2 py-3 text-right font-mono tabular-nums @xl:table-cell">{formatMoney(row.netSales, currency)}</td>
                    <td
                      className={`px-2 py-3 text-right font-mono font-semibold tabular-nums ${negative ? "text-danger-strong" : "text-success-strong"}`}
                    >
                      {formatMoney(row.grossProfit, currency)}
                    </td>
                    <td className="py-3 pl-2 text-right">
                      <MarginChip margin={row.margin} status={row.status} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
