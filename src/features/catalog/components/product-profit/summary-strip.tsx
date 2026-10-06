import { StatusLabel } from "@/features/ledger/components/status-label"
import { formatMoney } from "@/lib/format"

/**
 * The totals for the whole choice, as the P&L engine worked them out. None is
 * added up here: they are the SQL summary's own figures, shown beside the
 * products so the list below has something to be read against.
 */
export type ProfitTotals = {
  netSales: string
  /** NULL unless final; the "so far" figure is `contributionBefore`. */
  contribution: string | null
  contributionBefore: string | null
  cogs: string | null
  grossProfit: string | null
  grossProfitBefore: string | null
}

function Tile({
  label,
  value,
  note,
  status,
}: {
  label: string
  value: string
  note: string
  status?: "FINAL" | "INCOMPLETE"
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {status && <StatusLabel status={status} />}
      </div>
      <p className="mt-2 font-mono text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  )
}

export function SummaryStrip({ totals, currency }: { totals: ProfitTotals; currency: string }) {
  const money = (value: string | null) => formatMoney(value, currency)
  const contributionFinal = totals.contribution !== null
  const grossFinal = totals.grossProfit !== null

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Tile label="Net sales" value={money(totals.netSales)} note="After refunds and discounts" />
      <Tile
        label="Contribution"
        value={money(contributionFinal ? totals.contribution : totals.contributionBefore)}
        note={contributionFinal ? "After marketplace costs" : "So far, not final"}
        status={contributionFinal ? "FINAL" : "INCOMPLETE"}
      />
      <Tile
        label="Cost of goods"
        value={totals.cogs === null ? "Incomplete" : money(totals.cogs)}
        note="At each sale date's product cost"
      />
      <Tile
        label="Gross profit"
        value={money(grossFinal ? totals.grossProfit : totals.grossProfitBefore)}
        note={grossFinal ? "After marketplace costs and cost of goods" : "So far, not final"}
        status={grossFinal ? "FINAL" : "INCOMPLETE"}
      />
    </div>
  )
}
