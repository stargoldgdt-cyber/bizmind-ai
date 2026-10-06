import { createHash } from "node:crypto"

import type { LedgerFilePayload } from "./ledger-file"

/**
 * Splits a big settlement file into parts the database can record in time.
 *
 * WHY. ledger_apply_file() validates and writes a whole file in one statement,
 * and the API gives a statement about 8 seconds. Measured on the live database
 * (2026-10-06) it takes about 3 ms per source row, so a file of a few thousand
 * rows is already borderline and a noon month of 4,600 orders (about 10,000
 * rows) can never fit. Each part is a complete, valid file of its own, recorded
 * by its own call to the same single writer, so nothing about the ledger's rules
 * changes.
 *
 * PURE AND DETERMINISTIC. The same file always splits the same way, so a failed
 * upload can simply be repeated: every part carries its own fingerprint derived
 * from the file's, and a part that is already recorded is skipped as "the same
 * file again" (the database's own no-op), never written twice.
 *
 * WHAT STAYS TOGETHER. Rows that belong together are never separated:
 *   - a row that names a settlement or payout, and the row that holds it
 *     (the database refuses a reference to something outside the file);
 *   - rows whose raw values are identical (the database refuses a row it has
 *     already counted from another file, so identical rows split across two
 *     parts would be refused as an overlap with each other).
 * A file whose rows are all tied together (an Amazon settlement refers to its
 * one settlement from every row) is therefore one part, exactly as before.
 *
 * Nothing here touches money: it moves records between parts unchanged.
 */

/** Rows per part. About 2.5 s of database work at the measured rate, leaving room for a busy moment. */
export const LEDGER_PART_ROWS = 800

/**
 * A file up to this many rows is recorded whole. About 4.5 s of database work at
 * the measured rate against an 8 s limit, so a normal month goes in as one file.
 * A busier moment than usual can still push it over; the upload then retries
 * itself in parts (see `forceParts`), so nobody has to decide anything.
 */
export const LEDGER_SINGLE_FILE_ROWS = 1_500

/** The most parts one file may split into (a safety stop, not a target). */
export const MAX_LEDGER_PARTS = 60

class DisjointSets {
  private parent: number[]
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index)
  }
  find(index: number): number {
    let root = index
    while (this.parent[root] !== root) root = this.parent[root]
    // Path compression, so long chains stay cheap.
    let cursor = index
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor]
      this.parent[cursor] = root
      cursor = next
    }
    return root
  }
  union(a: number, b: number) {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA !== rootB) this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
  }
}

/** A part's own fingerprint: stable for the same file and the same split, different for every part. */
export function partFingerprint(fileSha256: string, index: number, count: number): string {
  return createHash("sha256").update(`${fileSha256}:part:${index + 1}:of:${count}`).digest("hex")
}

function partName(name: string, index: number, count: number): string {
  const suffix = ` (part ${index + 1} of ${count})`
  return `${name.slice(0, 255 - suffix.length)}${suffix}`
}

/**
 * `maxRows` is the size of a part. `singleUpTo` is how many rows may still be
 * recorded whole (it defaults to `maxRows`: split as soon as it would not fit in
 * one part). `forceParts` splits even a file within `singleUpTo`, which is what
 * the upload does after a whole-file attempt ran out of time.
 */
export function splitLedgerFilePayload(
  payload: LedgerFilePayload,
  maxRows = LEDGER_PART_ROWS,
  singleUpTo = maxRows,
  forceParts = false
): LedgerFilePayload[] {
  const rows = [...payload.rows].sort((a, b) => a.row_number - b.row_number)
  if (rows.length <= (forceParts ? maxRows : singleUpTo)) return [payload]

  const indexOfRow = new Map<number, number>()
  rows.forEach((row, index) => indexOfRow.set(row.row_number, index))
  const sets = new DisjointSets(rows.length)

  // A row and the settlement or payout it refers to.
  const settlementRow = new Map<string, number>()
  for (const settlement of payload.settlements) {
    const index = indexOfRow.get(settlement.source_row_number)
    if (index !== undefined) settlementRow.set(settlement.external_settlement_id, index)
  }
  const payoutRow = new Map<string, number>()
  for (const payout of payload.payouts) {
    const index = indexOfRow.get(payout.source_row_number)
    if (index === undefined) continue
    payoutRow.set(payout.key, index)
    const settlement = payout.settlement_ref ? settlementRow.get(payout.settlement_ref) : undefined
    if (settlement !== undefined) sets.union(index, settlement)
  }
  for (const transaction of payload.transactions) {
    const own = indexOfRow.get(transaction.source_row_number)
    if (own === undefined) continue
    const settlement = transaction.settlement_ref ? settlementRow.get(transaction.settlement_ref) : undefined
    if (settlement !== undefined) sets.union(own, settlement)
    const payout = transaction.payout_ref ? payoutRow.get(transaction.payout_ref) : undefined
    if (payout !== undefined) sets.union(own, payout)
  }

  // Identical rows stay together (see the header).
  const seen = new Map<string, number>()
  rows.forEach((row, index) => {
    const fingerprint = JSON.stringify(Object.entries(row.raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    const first = seen.get(fingerprint)
    if (first === undefined) seen.set(fingerprint, index)
    else sets.union(first, index)
  })

  // Components, in file order, packed into parts of at most `maxRows`. One that is
  // larger than a part on its own simply becomes a part.
  const componentRows = new Map<number, number[]>()
  rows.forEach((_, index) => {
    const root = sets.find(index)
    const list = componentRows.get(root)
    if (list) list.push(index)
    else componentRows.set(root, [index])
  })
  const groups: number[][] = []
  let current: number[] = []
  for (const component of [...componentRows.entries()].sort(([a], [b]) => a - b).map(([, list]) => list)) {
    if (current.length > 0 && current.length + component.length > maxRows) {
      groups.push(current)
      current = []
    }
    current.push(...component)
  }
  if (current.length > 0) groups.push(current)

  if (groups.length === 1) return [payload]
  if (groups.length > MAX_LEDGER_PARTS) {
    throw new Error(`This file would need ${groups.length} parts; the most BizMind records at once is ${MAX_LEDGER_PARTS}. Split it by period.`)
  }

  const count = groups.length
  return groups.map((indexes, partIndex) => {
    const wanted = new Set(indexes.map((index) => rows[index].row_number))
    const kept = rows.filter((row) => wanted.has(row.row_number))
    return {
      ...payload,
      file_name: partName(payload.file_name, partIndex, count),
      file_sha256: partFingerprint(payload.file_sha256, partIndex, count),
      // About this part's share of the file, for the imports list.
      file_size_bytes: Math.max(1, Math.round(payload.file_size_bytes * (kept.length / rows.length))),
      rows: kept,
      settlements: payload.settlements.filter((s) => wanted.has(s.source_row_number)),
      payouts: payload.payouts.filter((p) => wanted.has(p.source_row_number)),
      transactions: payload.transactions.filter((t) => wanted.has(t.source_row_number)),
      issues: payload.issues.filter((i) => wanted.has(i.row_number)),
    }
  })
}
