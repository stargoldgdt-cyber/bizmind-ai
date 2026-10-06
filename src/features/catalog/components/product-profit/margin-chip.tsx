import { formatPercent } from "@/lib/format"
import type { ProfitStatus } from "@/services/catalog/product-profit-view"

/**
 * A margin shown as a chip tinted by its group. The sign is part of the text
 * and the group has its own pill beside it, so colour is never the only signal.
 * A product with no final margin shows a dash, not a guess.
 */
const TONE: Record<ProfitStatus, string> = {
  LOSS: "bg-danger-subtle text-danger-strong",
  LOW_MARGIN: "bg-warning-subtle text-warning-strong",
  GOOD: "bg-success-subtle text-success-strong",
  HIGH_MARGIN: "bg-success-subtle text-success-strong",
  MISSING_COST: "text-muted-foreground",
  NEEDS_MAPPING: "text-muted-foreground",
}

export function MarginChip({ margin, status }: { margin: string | null; status: ProfitStatus }) {
  if (margin === null) return <span className="text-muted-foreground">—</span>
  return (
    <span
      className={`inline-flex min-w-16 justify-center rounded-md px-2 py-1 font-mono text-xs font-semibold tabular-nums ${TONE[status]}`}
    >
      {formatPercent(margin)}
    </span>
  )
}
