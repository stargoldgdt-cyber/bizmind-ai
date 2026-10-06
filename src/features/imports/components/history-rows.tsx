"use client"

import Link from "next/link"
import { useState } from "react"
import { ChevronRight } from "lucide-react"

import { TableCell, TableRow } from "@/components/ui/table"
import { groupTotals, partOf, type ImportGroup } from "@/features/imports/groups"
import type { DataSource } from "@/features/imports/queries"
import { formatNumber } from "@/lib/format"
import { importEntityLabel } from "@/services/ingestion/entities"

/**
 * The rows of the Data sources History table.
 *
 * A file recorded in parts (a large settlement) is ONE row with its totals and
 * a toggle that shows the parts; every other source is a row as before. Counts
 * only: nothing here adds up money.
 */

/** Where this data came from, in the owner's language. */
function sourceLabel(row: DataSource): string {
  if (row.dataset === "LEDGER") return row.marketplace_label ?? "Marketplace file"
  if (row.connection_name) return row.connection_name
  if (row.file_type === "api") return "Synced"
  return row.source ? `File · ${row.source}` : "File"
}

const STATUS_STYLE: Record<string, string> = {
  COMPLETED: "bg-success-subtle text-success-strong",
  FAILED: "bg-danger-subtle text-danger-strong",
  DRAFT: "bg-muted text-muted-foreground",
  READY: "bg-info-subtle text-info-strong",
  CANCELLED: "bg-muted text-muted-foreground",
}

const STATUS_LABEL: Record<string, string> = {
  COMPLETED: "Imported",
  FAILED: "Failed",
  DRAFT: "Not finished",
  READY: "Ready",
  CANCELLED: "Cancelled",
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`inline-flex rounded-4xl px-2 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>
}

function StatusBadge({ row }: { row: DataSource }) {
  if (row.withdrawn_at) return <Badge className="bg-muted text-muted-foreground">Withdrawn</Badge>
  return <Badge className={STATUS_STYLE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
}

const num = "text-right font-mono text-xs tabular-nums"

export function HistoryRow({ row, indent = false }: { row: DataSource; indent?: boolean }) {
  const part = partOf(row.file_name)
  return (
    <TableRow className={row.withdrawn_at ? "opacity-60" : indent ? "bg-muted/30" : ""}>
      <TableCell className="max-w-56">
        <Link
          href={`/imports/${row.batch_id}`}
          className={`block truncate font-medium underline-offset-4 hover:underline ${indent ? "pl-6" : ""}`}
        >
          {indent && part ? `Part ${part.part} of ${part.of}` : row.file_name}
        </Link>
        <span className={`block truncate text-[11px] text-muted-foreground ${indent ? "pl-6" : ""}`}>{sourceLabel(row)}</span>
      </TableCell>
      <TableCell className="text-xs">{row.dataset === "LEDGER" ? "Settlement" : importEntityLabel(row.entity)}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{new Date(row.created_at).toLocaleDateString()}</TableCell>
      <TableCell>
        <StatusBadge row={row} />
      </TableCell>
      <TableCell className={num}>{formatNumber(row.row_count)}</TableCell>
      <TableCell className={num}>{row.created_count === null ? "—" : formatNumber(row.created_count)}</TableCell>
      <TableCell className={num}>{row.updated_count === null ? "—" : formatNumber(row.updated_count)}</TableCell>
      <TableCell className={num}>{row.rows_failed === null ? "—" : formatNumber(row.rows_failed)}</TableCell>
      <TableCell className={`${num} text-muted-foreground`}>{row.warnings_count === 0 ? "—" : formatNumber(row.warnings_count)}</TableCell>
      <TableCell className={num}>
        {row.withdrawn_at ? "withdrawn" : row.records_written === 0 ? "—" : formatNumber(row.records_written)}
      </TableCell>
      <TableCell className="text-right">
        <Link href={`/imports/${row.batch_id}`} className="text-xs font-medium underline-offset-4 hover:underline">
          Details
        </Link>
      </TableCell>
    </TableRow>
  )
}

export function HistoryGroup({ group }: { group: ImportGroup }) {
  const [open, setOpen] = useState(false)
  const totals = groupTotals(group)
  const first = group.parts[0]
  const allWithdrawn = totals.withdrawn === group.parts.length
  const latest = group.parts.reduce((max, part) => (part.created_at > max ? part.created_at : max), first.created_at)
  const failed = group.parts.some((part) => part.status === "FAILED")

  return (
    <>
      <TableRow className={allWithdrawn ? "opacity-60" : ""}>
        <TableCell className="max-w-56">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="flex w-full items-center gap-1.5 text-left"
          >
            <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
            <span className="min-w-0">
              <span className="block truncate font-medium">{group.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {sourceLabel(first)} · {group.parts.length} part{group.parts.length === 1 ? "" : "s"}
                {totals.complete ? "" : ` of ${group.of} recorded`}
              </span>
            </span>
          </button>
        </TableCell>
        <TableCell className="text-xs">Settlement</TableCell>
        <TableCell className="text-xs text-muted-foreground">{new Date(latest).toLocaleDateString()}</TableCell>
        <TableCell>
          {allWithdrawn ? (
            <Badge className="bg-muted text-muted-foreground">Withdrawn</Badge>
          ) : totals.withdrawn > 0 ? (
            <Badge className="bg-warning-subtle text-warning-strong">Partly withdrawn</Badge>
          ) : !totals.complete || failed ? (
            <Badge className="bg-warning-subtle text-warning-strong">Not finished</Badge>
          ) : (
            <Badge className="bg-success-subtle text-success-strong">Imported</Badge>
          )}
        </TableCell>
        <TableCell className={num}>{formatNumber(totals.rows)}</TableCell>
        <TableCell className={num}>{formatNumber(totals.added)}</TableCell>
        <TableCell className={num}>0</TableCell>
        <TableCell className={num}>{formatNumber(totals.skipped)}</TableCell>
        <TableCell className={`${num} text-muted-foreground`}>{totals.warnings === 0 ? "—" : formatNumber(totals.warnings)}</TableCell>
        <TableCell className={num}>{allWithdrawn ? "withdrawn" : totals.counting === 0 ? "—" : formatNumber(totals.counting)}</TableCell>
        <TableCell className="text-right">
          <Link href={`/imports/${first.batch_id}`} className="text-xs font-medium underline-offset-4 hover:underline">
            Details
          </Link>
        </TableCell>
      </TableRow>
      {open && group.parts.map((part) => <HistoryRow key={part.batch_id} row={part} indent />)}
    </>
  )
}
