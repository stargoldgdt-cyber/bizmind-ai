import { RangeSelector } from "./range-selector"
import type { ResolvedPeriod } from "@/services/analytics"

/**
 * The heading every analytics page shares.
 *
 * Title, the period in one line, and the period control. Identical on every
 * page so an owner moving between them never has to re-find the date filter —
 * and so the currency is always stated, because a figure without its currency
 * is a number, not an amount.
 */
export function PageHeader({
  title,
  description,
  period,
  currency,
  basePath,
}: {
  title: string
  description?: string
  period: ResolvedPeriod
  currency: string
  basePath: string
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {period.label} · {period.comparisonLabel} · figures in {currency}
        </p>
        {description && (
          <p className="mt-2 max-w-prose-comfortable text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>

      <RangeSelector
        active={period.key}
        basePath={basePath}
        customLabel={period.key === "custom" ? period.label : undefined}
      />
    </div>
  )
}
