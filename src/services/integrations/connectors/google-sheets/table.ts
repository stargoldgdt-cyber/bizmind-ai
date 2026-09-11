import { isExactNumber } from "@/lib/json-exact"
import type { RawRecord } from "@/services/ingestion/contracts"

import type { SheetCell } from "./client"

/**
 * Turning a sheet's rows into records -- by the Excel importer's rules.
 *
 * WHY THE RULES ARE COPIED EXACTLY
 * --------------------------------
 * `parseXlsx()` decides what a column is called and which rows count. A Google
 * Sheet holding the same data must produce the same headings and the same
 * records, or a mapping saved for the Excel export would not recognise the
 * sheet, and the owner would be asked the same questions twice. So, as there:
 *
 *   - row 1 holds the headings, trimmed
 *   - a blank heading means the column is ignored
 *   - a heading that repeats: the LAST column with it wins
 *   - an empty cell is absent from the record, never an empty string
 *   - a row with nothing in it is dropped
 *
 * One deliberate difference: a number arrives as an `ExactNumber` carrying the
 * digits Google sent, where ExcelJS hands over a JavaScript double. The
 * normaliser reads both.
 *
 * Pure functions: no network, no secrets, nothing to mock.
 */

function cellText(cell: SheetCell): string {
  if (cell === null || cell === undefined) return ""
  if (typeof cell === "boolean") return String(cell)
  if (isExactNumber(cell)) return cell.text
  return cell
}

/** The heading row, exactly as the Excel importer reads one. */
export function headingsFrom(row: readonly SheetCell[]): string[] {
  return row.map((cell) => cellText(cell).trim())
}

/**
 * Records keyed by heading, and the sheet row each came from.
 *
 * The row number is kept for lineage -- "Revenue <- Sales 2026 <- Orders tab
 * <- row 1,284" -- and is never used as an identity: rows move whenever
 * someone sorts, inserts or deletes.
 */
export function recordsFrom(
  headers: readonly string[],
  rows: readonly (readonly SheetCell[])[],
  firstRowNumber: number
): { records: RawRecord[]; rowNumbers: number[] } {
  const records: RawRecord[] = []
  const rowNumbers: number[] = []

  rows.forEach((row, index) => {
    const record: RawRecord = {}
    let hasValue = false

    row.forEach((cell, column) => {
      const key = headers[column]
      if (!key) return
      if (cell === null || cell === undefined || cell === "") return

      // Booleans as Excel reports them: "true" / "false".
      const value = typeof cell === "boolean" ? String(cell) : cell
      if (typeof value !== "string" || value.trim() !== "") hasValue = true
      record[key] = value
    })

    if (!hasValue) return
    records.push(record)
    rowNumbers.push(firstRowNumber + index)
  })

  return { records, rowNumbers }
}

/** A record's values as display text, for the preview. Converts nothing numeric. */
export function displayRecord(record: RawRecord): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = isExactNumber(value) ? value.text : String(value)
  }
  return out
}
