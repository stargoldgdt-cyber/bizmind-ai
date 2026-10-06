import Link from "next/link"
import { TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { LOW_MARGIN_BELOW, type Attention } from "@/services/catalog/product-profit-view"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * What needs doing first, in a sentence. Counts only: it is the rows below
 * summed up by group, so it can never disagree with them.
 */
export function AttentionBanner({ attention }: { attention: Attention }) {
  const setup = attention.missingCost + attention.needsMapping
  if (attention.needAttention === 0 && setup === 0) return null

  const parts = [
    attention.loss > 0 && `${plural(attention.loss, "product loses", "products lose")} money.`,
    attention.lowMarginHighSales > 0 &&
      `${plural(attention.lowMarginHighSales, "high-selling product has a margin", "high-selling products have margins")} below ${LOW_MARGIN_BELOW}%.`,
    setup > 0 && "Gross profit is not final for some products because a cost or a SKU match is missing.",
  ].filter(Boolean)

  return (
    <section role="status" className="flex flex-wrap items-center gap-4 rounded-xl border border-warning/40 bg-warning-subtle px-5 py-4">
      <TriangleAlert className="size-6 shrink-0 text-warning-strong" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {attention.needAttention > 0
            ? `${plural(attention.needAttention, "product needs", "products need")} attention.`
            : "Some products are not set up yet."}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{parts.join(" ")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline" className="rounded-4xl bg-card">
          <Link href="#all-products">View products</Link>
        </Button>
        {setup > 0 && (
          <Button asChild size="sm" className="rounded-4xl">
            <Link href="/catalog#needs-attention">Set up missing costs</Link>
          </Button>
        )}
      </div>
    </section>
  )
}
