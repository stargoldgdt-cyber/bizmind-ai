import { formatMoney, formatPercent } from "@/lib/format"
import {
  attentionOf,
  biggestLeaks,
  insightsOf,
  topProfitable,
  type ProfitViewRow,
} from "@/services/catalog/product-profit-view"

import { AttentionBanner } from "./attention-banner"
import { InsightsCard } from "./insights-card"
import { ProductTable } from "./product-table"
import { RankedCard } from "./ranked-card"
import { SummaryStrip, type ProfitTotals } from "./summary-strip"

/**
 * Everything under the filters on the Product profitability page. A separate
 * component so the page and any preview render exactly the same thing.
 */
export function ProductProfitBody({
  items,
  totals,
  notAllocatedContribution,
  currency,
  monthLabel,
}: {
  items: ProfitViewRow[]
  totals: ProfitTotals | null
  /** The contribution of the lines no product owns, when there are any. */
  notAllocatedContribution: string | null
  currency: string
  monthLabel: string
}) {
  const money = (value: string | null | undefined) => formatMoney(value, currency)
  const attention = attentionOf(items)
  const insights = insightsOf(items, (value) => formatMoney(value, currency), formatPercent)

  return (
    <>
      <AttentionBanner attention={attention} />

      {totals && <SummaryStrip totals={totals} currency={currency} />}

      {/* The two lists side by side; the insights get their own full-width row,
          because three cards across leave each too narrow beside the sidebar. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <RankedCard
            title="Top profitable products"
            tone="success"
            rows={topProfitable(items)}
            currency={currency}
            empty="No product has a final profit yet."
          />
        </div>
        <div>
          <RankedCard
            title="Biggest profit leaks"
            tone="danger"
            rows={biggestLeaks(items)}
            currency={currency}
            empty="No product is losing money or earning very little."
          />
        </div>
        <div className="lg:col-span-2">
          <InsightsCard insights={insights} />
        </div>
      </div>

      <ProductTable rows={items} currency={currency} />

      <section className="rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
        {notAllocatedContribution !== null && (
          <p>
            <span className="font-medium text-foreground">Not allocated to a product:</span>{" "}
            {money(notAllocatedContribution)}. Fees and advertising the marketplace charges for the whole account and
            order-level lines no product owns stay in their own row and are never spread across products.
          </p>
        )}
        {totals && (
          <p className={notAllocatedContribution !== null ? "mt-2" : undefined}>
            <span className="font-medium text-foreground">All rows together</span> ({monthLabel}): contribution{" "}
            {money(totals.contributionBefore)}, cost of goods {money(totals.cogs)}
            {totals.grossProfit === null ? " (not final)" : `, gross profit ${money(totals.grossProfit)}`}.
          </p>
        )}
      </section>
    </>
  )
}
