import Link from "next/link"
import { Info } from "lucide-react"

import { compareMoney } from "@/services/analytics/money"
import { formatMoney, formatPercent } from "@/lib/format"
import { TARGET_MARGINS, type AnalysisPrice } from "@/services/catalog/product-analysis"

/**
 * What price would earn a chosen margin. Every figure was worked out in SQL
 * (product_analysis); the target is one of a fixed list carried in the URL.
 *
 * It is an estimate and says so: marketplace costs per unit are kept where
 * they are, so a commission that grows with the price would grow too. It is
 * not shown at all unless every unit sold has a cost.
 */
export function PriceCheck({
  price,
  currency,
  hrefs,
}: {
  price: AnalysisPrice | null
  currency: string
  /** The page address for each target margin. */
  hrefs: Record<number, string>
}) {
  if (!price) {
    return (
      <p className="px-5 py-8 text-center text-sm text-muted-foreground">
        The price check needs sales and a cost for every unit sold in this period.
      </p>
    )
  }
  const below = compareMoney(price.average_price, price.break_even_price) < 0
  const increase = price.increase_amount !== null && compareMoney(price.increase_amount, "0") > 0

  return (
    <div className="space-y-4 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Target margin">
        <span className="text-xs font-medium text-muted-foreground">Target margin</span>
        {TARGET_MARGINS.map((margin) => (
          <Link
            key={margin}
            href={hrefs[margin]}
            scroll={false}
            aria-current={margin === price.target_margin ? "true" : undefined}
            className={
              margin === price.target_margin
                ? "rounded-full border border-primary bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
                : "rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }
          >
            {margin}%
          </Link>
        ))}
      </div>

      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-3">
          <dt className="text-xs text-muted-foreground">Average selling price</dt>
          <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">{formatMoney(price.average_price, currency)}</dd>
        </div>
        <div className="rounded-lg border border-border p-3">
          <dt className="text-xs text-muted-foreground">Break-even price</dt>
          <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">{formatMoney(price.break_even_price, currency)}</dd>
          <dd className={`mt-0.5 text-xs ${below ? "font-medium text-danger-strong" : "text-muted-foreground"}`}>
            {below ? "Average price is below break-even" : "Average price covers its costs"}
          </dd>
        </div>
        <div className="rounded-lg border border-border p-3">
          <dt className="text-xs text-muted-foreground">Price for a {price.target_margin}% margin</dt>
          <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">
            {price.required_price === null ? "—" : formatMoney(price.required_price, currency)}
          </dd>
        </div>
      </dl>

      <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span>
          {increase && price.increase_amount !== null && price.increase_pct !== null
            ? `To reach a ${price.target_margin}% margin, the average price would need to rise by ${formatMoney(price.increase_amount, currency)} (${formatPercent(price.increase_pct)}).`
            : `The average price already earns at least a ${price.target_margin}% margin.`}{" "}
          <span className="text-muted-foreground">
            This is an estimate: it keeps the marketplace costs per unit ({formatMoney(price.unit_costs, currency)}) and the product cost
            ({formatMoney(price.unit_cogs, currency)}) as they are.
          </span>
        </span>
      </p>
    </div>
  )
}
