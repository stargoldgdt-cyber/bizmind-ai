import type { DataSource } from "@/features/imports/queries"

/**
 * Parts of one large settlement file, shown as one file.
 *
 * A big file is recorded in parts (services/marketplaces/ledger-file-parts.ts),
 * each a file of its own named "<name> (part 2 of 6)". The History list and the
 * detail page show them as ONE file again, with the parts a click away.
 *
 * Parts are recognised by that name, the account and the format, and by being
 * recorded close together, so uploading the same file name again another day is
 * a new file, not more parts of the old one. A part number that repeats starts a
 * new group (the same file recorded again after the first was withdrawn).
 *
 * Pure: it groups and counts what the database already reports. Row, line and
 * record counts are whole numbers; no money is involved.
 */

const PART_NAME = /^(.*) \(part (\d+) of (\d+)\)$/

/** Parts of one upload are recorded within minutes of each other. */
const SAME_UPLOAD_WITHIN_MS = 30 * 60 * 1000

export function partOf(fileName: string): { base: string; part: number; of: number } | null {
  const match = PART_NAME.exec(fileName)
  if (!match) return null
  const part = Number(match[2])
  const of = Number(match[3])
  if (!Number.isInteger(part) || !Number.isInteger(of) || part < 1 || of < 2 || part > of) return null
  return { base: match[1], part, of }
}

export type ImportGroup = {
  kind: "group"
  key: string
  /** The file's own name, without the part suffix. */
  name: string
  /** How many parts the file was split into. */
  of: number
  /** The parts that exist, in order. Fewer than `of` means an upload that stopped part-way. */
  parts: DataSource[]
}

export type ImportEntry = { kind: "single"; row: DataSource } | ImportGroup

export function groupDataSources(rows: readonly DataSource[]): ImportEntry[] {
  // Oldest first, so parts of one upload line up and the newest group is built last.
  const ordered = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const entries: { at: string; entry: ImportEntry }[] = []
  const open = new Map<string, { group: ImportGroup; last: number }>()

  for (const row of ordered) {
    const info = row.dataset === "LEDGER" ? partOf(row.file_name) : null
    if (!info) {
      entries.push({ at: row.created_at, entry: { kind: "single", row } })
      continue
    }

    const key = `${row.marketplace_account_id}|${row.format_id}|${info.base}|${info.of}`
    const time = new Date(row.created_at).getTime()
    const current = open.get(key)
    const sameUpload =
      current &&
      time - current.last <= SAME_UPLOAD_WITHIN_MS &&
      !current.group.parts.some((part) => partOf(part.file_name)?.part === info.part)

    if (current && sameUpload) {
      current.group.parts.push(row)
      current.last = time
      continue
    }

    const group: ImportGroup = { kind: "group", key: `${key}|${row.batch_id}`, name: info.base, of: info.of, parts: [row] }
    open.set(key, { group, last: time })
    entries.push({ at: row.created_at, entry: group })
  }

  for (const { entry } of entries) {
    if (entry.kind === "group") entry.parts.sort((a, b) => (partOf(a.file_name)?.part ?? 0) - (partOf(b.file_name)?.part ?? 0))
  }
  // A group is listed where its latest part was recorded, newest first like the rest of the list.
  const latest = (entry: ImportEntry) =>
    entry.kind === "single" ? entry.row.created_at : entry.parts.reduce((max, p) => (p.created_at > max ? p.created_at : max), "")
  return entries.map(({ entry }) => entry).sort((a, b) => latest(b).localeCompare(latest(a)))
}

/** What a group adds up to. All whole-number counts. */
export type GroupTotals = {
  rows: number
  added: number
  skipped: number
  warnings: number
  counting: number
  lines: number
  settlements: number
  payouts: number
  withdrawn: number
  complete: boolean
}

export function groupTotals(group: ImportGroup): GroupTotals {
  const sum = (pick: (row: DataSource) => number | null) => group.parts.reduce((total, row) => total + (pick(row) ?? 0), 0)
  const withdrawn = group.parts.filter((row) => row.withdrawn_at).length
  return {
    rows: sum((r) => r.row_count),
    added: sum((r) => r.created_count),
    skipped: sum((r) => r.rows_failed),
    warnings: sum((r) => r.warnings_count),
    counting: sum((r) => (r.withdrawn_at ? 0 : r.records_written)),
    lines: sum((r) => r.transactions_count),
    settlements: sum((r) => r.settlements_count),
    payouts: sum((r) => r.payouts_count),
    withdrawn,
    complete: group.parts.length === group.of,
  }
}

/** The group a given file belongs to, or null when it is not a part. */
export function groupOf(rows: readonly DataSource[], batchId: string): ImportGroup | null {
  for (const entry of groupDataSources(rows)) {
    if (entry.kind === "group" && entry.parts.some((part) => part.batch_id === batchId)) return entry
  }
  return null
}
