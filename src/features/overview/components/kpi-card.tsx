import Link from "next/link"
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"

import { cn } from "cn"
import { StatusLabel } from "@/features/ledger/components/status-label"
import { formatPercent } from "@/lib/format"

/**
 * One headline figure on the home dashboard.
 *
 * An incomplete figure shows the word "Incomplete", never a number; a "so
 * far" figure may appear in the note, labelled as not final. The change
 * against last month is a percentage the database worked out, shown with an
 * arrow AND a word, so direction never depends on colour alone.
 */
export function KpiCard({
  label,
  value,
  status,
  note,
  change,
  changeLabel = "",
  risingIsGood = true,
  href,
  emphasis = false,
}: {
  label: string
  value: string
  status?: "FINAL" | "INCOMPLETE" | null
  note?: string
  change?: number | null
  changeLabel?: string
  risingIsGood?: boolean
  href?: string
  emphasis?: boolean
}) {
  const body = (
    <div
      className={cn(
        "flex h-full flex-col gap-2 rounded-xl border bg-card p-4 transition-colors",
        emphasis ? "border-primary/35" : "border-border",
        href && "hover:border-primary/40 hover:bg-muted/30"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        {status && <StatusLabel status={status} />}
      </div>
      <p
        className={cn(
          "whitespace-nowrap font-mono text-2xl font-semibold tracking-tight tabular-nums 2xl:text-xl",
          value === "Incomplete" && "font-sans text-lg text-warning-strong"
        )}
      >
        {value}
      </p>
      {change !== undefined && <ChangeChip change={change} label={changeLabel} risingIsGood={risingIsGood} />}
      {note && <p className="mt-auto text-xs text-muted-foreground">{note}</p>}
    </div>
  )
  return href ? (
    <Link href={href} className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  )
}

export function ChangeChip({
  change,
  label,
  risingIsGood,
}: {
  change: number | null
  label: string
  risingIsGood: boolean
}) {
  if (change === null) {
    return <p className="text-xs text-muted-foreground">{label ? `No comparison ${label}` : "Not compared"}</p>
  }
  const rising = change > 0
  const flat = change === 0
  const good = flat ? null : rising === risingIsGood
  const Icon = flat ? Minus : rising ? ArrowUpRight : ArrowDownRight
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-1 text-xs font-medium tabular-nums",
        good === null ? "text-muted-foreground" : good ? "text-success-strong" : "text-danger-strong"
      )}
    >
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <Icon className="size-3.5" aria-hidden />
        {flat ? "No change" : `${rising ? "Up" : "Down"} ${formatPercent(Math.abs(change))}`}
      </span>
      <span className="font-normal text-muted-foreground">{label}</span>
    </p>
  )
}
