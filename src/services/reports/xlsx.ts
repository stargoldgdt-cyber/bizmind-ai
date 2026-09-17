import ExcelJS from "exceljs"

import type { Cell, CellKind, Report } from "./catalog"

/**
 * Writes a report as an Excel workbook (GCC Phase 8).
 *
 * EXACTNESS
 * ---------
 * Excel keeps a number to 15 significant digits. A figure is written as a
 * number only when its exact decimal text has at most 15 significant digits,
 * so Excel holds every digit the database produced; anything longer is written
 * as its exact text instead of being rounded. This is a change of cell type,
 * never arithmetic.
 *
 * SAFETY
 * ------
 * Text that a spreadsheet would read as a formula is written with a leading
 * apostrophe, as in the CSV export. Nothing in a report is a formula.
 */

const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/
const FORMULA_START = /^[=+\-@\t\r]/
const MAX_SIGNIFICANT = 15

const FORMAT: Partial<Record<CellKind, string>> = {
  money: "#,##0.00##;[Red]-#,##0.00##",
  count: "#,##0.####",
  percent: "0.0\"%\"",
}

/** The exact text as an Excel number when no digit would be lost; otherwise the text. */
export function spreadsheetNumber(text: string): number | string {
  if (!EXACT_DECIMAL.test(text)) return text
  const digits = text.replace(/^-/, "").replace(".", "").replace(/^0+/, "")
  const significant = digits.replace(/0+$/, "").length
  if (significant > MAX_SIGNIFICANT) return text
  return Number(text)
}

export function spreadsheetText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value
}

function cellValue(value: Cell, kind: CellKind): ExcelJS.CellValue {
  if (value === null) return null
  if (typeof value === "number") return value
  if (kind === "money" || kind === "count" || kind === "percent") return spreadsheetNumber(value)
  if (kind === "date") {
    // Dates are shown as the UTC calendar day the engine counts in.
    const day = value.slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : spreadsheetText(value)
  }
  return spreadsheetText(value)
}

export async function reportWorkbook(report: Report): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = "BizMind AI"
  workbook.created = new Date()

  const about = workbook.addWorksheet("About")
  about.columns = [{ width: 18 }, { width: 90 }]
  about.addRow([report.title]).font = { bold: true, size: 14 }
  about.addRow([])
  for (const [label, text] of report.about) {
    const row = about.addRow([spreadsheetText(label), spreadsheetText(text)])
    row.getCell(1).font = { bold: true }
    row.getCell(2).alignment = { wrapText: true, vertical: "top" }
  }

  for (const sheet of report.sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31))
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      width: c.width ?? Math.max(12, Math.min(28, c.header.length + 4)),
      style: FORMAT[c.kind] ? { numFmt: FORMAT[c.kind] } : {},
    }))
    ws.getRow(1).font = { bold: true }
    ws.views = [{ state: "frozen", ySplit: 1 }]
    for (const row of sheet.rows) {
      ws.addRow(row.map((value, index) => cellValue(value, sheet.columns[index]?.kind ?? "text")))
    }
    if (sheet.rows.length === 0) ws.addRow(["Nothing to show for this period."])
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}
