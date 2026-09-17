import Link from "next/link"

import { StatusLabel } from "./status-label"

/**
 * One headline figure with its status.
 *
 * An incomplete figure never shows a number as if it were final: `value` is
 * whatever the page decided to show (a dash, or "Incomplete"), and anything
 * informational goes in `note`, labelled as such.
 */
export function FigureCard({
  label,
  value,
  status,
  note,
  href,
  emphasis = false,
}: {
  label: string
  value: string
  status: "FINAL" | "INCOMPLETE"
  note?: string
  href?: string
  emphasis?: boolean
}) {
  return (
    <div
      className={
        emphasis
          ? "flex flex-col gap-2 rounded-xl border border-primary/30 bg-card p-4"
          : "flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <StatusLabel status={status} />
      </div>
      <p className="font-mono text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {href && (
        <Link href={href} className="mt-auto text-xs font-medium underline-offset-4 hover:underline">
          See the lines
        </Link>
      )}
    </div>
  )
}
