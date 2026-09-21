import "server-only"

import ExcelJS from "exceljs"

import { spreadsheetNumber } from "@/services/reports/xlsx"

import {
  MARKETPLACE_NAMES,
  SKU_SETUP_COLUMNS,
  type SkuSetupColumnKey,
  type SkuSetupRecord,
} from "./sku-setup"

/**
 * The one-sheet SKU setup workbook: writing it for download and reading it
 * back after the seller has filled it in (migration 0045).
 *
 * ONE sheet. BizMind fills the reference columns (marketplace, account, SKU,
 * currency, units sold, net sales); the seller fills Product SKU, and
 * optionally Product Name and COGS / Unit. Row 1 is the header and every later
 * row is one marketplace SKU, so a problem is reported with the row number the
 * seller sees in Excel.
 */

export type SkuSetupTemplateRow = {
  marketplace_code: string
  account_label: string
  currency: string
  raw_sku: string
  title: string | null
  product_sku: string | null
  product_name: string | null
  unit_cost: string | null
  units_sold: string
  net_sales: string
}

const SHEET_NAME = "SKU setup"
const FORMULA_START = /^[=+\-@\t\r]/

const HEADER_NOTE: Partial<Record<SkuSetupColumnKey, string>> = {
  productSku:
    "Your own code for the product. Several marketplace SKUs can share one Product SKU; they then share its cost.",
  productName: "Optional. Used only when BizMind creates a new product for this Product SKU.",
  unitCost:
    "Optional. What one unit costs you, as a plain number. A product's first cost applies from its first sale; a new cost for a product that already has one applies from today.",
  currency: "The currency of the cost. It is the marketplace account's currency.",
}

/** Text a spreadsheet would read as a formula gets a leading apostrophe. */
const safeText = (value: string) => (FORMULA_START.test(value) ? `'${value}` : value)

export async function skuSetupWorkbook(rows: SkuSetupTemplateRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = "BizMind"
  const sheet = workbook.addWorksheet(SHEET_NAME, { views: [{ state: "frozen", ySplit: 1 }] })

  sheet.columns = SKU_SETUP_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.key === "rawSku" || c.key === "productName" ? 36 : c.key === "account" ? 24 : 16,
  }))

  const header = sheet.getRow(1)
  header.font = { bold: true }
  SKU_SETUP_COLUMNS.forEach((c, index) => {
    const cell = header.getCell(index + 1)
    const note = HEADER_NOTE[c.key]
    if (note) cell.note = note
    // Columns the seller fills are marked in the header, so no colour is needed to find them.
    if (c.filledBy === "SELLER") cell.value = `${c.header} ✎`
  })

  for (const r of rows) {
    const row = sheet.addRow({
      marketplace: MARKETPLACE_NAMES[r.marketplace_code] ?? r.marketplace_code,
      account: safeText(r.account_label),
      rawSku: safeText(r.raw_sku),
      productSku: r.product_sku ? safeText(r.product_sku) : null,
      productName: safeText(r.product_name ?? r.title ?? ""),
      unitCost: r.unit_cost === null ? null : spreadsheetNumber(r.unit_cost),
      currency: r.currency,
      unitsSold: spreadsheetNumber(r.units_sold),
      netSales: spreadsheetNumber(r.net_sales),
    })
    row.getCell("unitCost").numFmt = "0.00##"
    row.getCell("netSales").numFmt = "#,##0.00;[Red]-#,##0.00"
    row.getCell("unitsSold").numFmt = "#,##0.####"
    for (const key of ["marketplace", "account", "rawSku", "currency", "unitsSold", "netSales"]) {
      // Reference columns are italic: BizMind filled them, the seller need not.
      row.getCell(key).font = { italic: true }
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export type ReadSkuSetup = { ok: true; records: SkuSetupRecord[] } | { ok: false; error: string }

/** Reads a filled setup sheet: header names to columns, then one record per row. */
export async function readSkuSetupWorkbook(buffer: Buffer): Promise<ReadSkuSetup> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch {
    return { ok: false, error: "That Excel file could not be opened. Upload the .xlsx you downloaded from BizMind." }
  }
  const sheet = workbook.getWorksheet(SHEET_NAME) ?? workbook.worksheets[0]
  if (!sheet) return { ok: false, error: "That workbook has no sheets." }

  const byHeader = new Map<string, SkuSetupColumnKey>(
    SKU_SETUP_COLUMNS.map((c) => [headerKey(c.header), c.key] as const)
  )
  const columnOf = new Map<number, SkuSetupColumnKey>()
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = byHeader.get(headerKey(cellText(cell.value)))
    if (key) columnOf.set(colNumber, key)
  })
  const found = new Set(columnOf.values())
  const missing = SKU_SETUP_COLUMNS.filter(
    (c) => ["marketplace", "rawSku", "productSku", "unitCost", "currency"].includes(c.key) && !found.has(c.key)
  )
  if (missing.length > 0) {
    return {
      ok: false,
      error: `The sheet is missing ${missing.map((c) => `"${c.header}"`).join(", ")}. Use the sheet downloaded from BizMind and keep its first row.`,
    }
  }

  const records: SkuSetupRecord[] = []
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    const cells: SkuSetupRecord["cells"] = {}
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = columnOf.get(colNumber)
      if (key) cells[key] = cellText(cell.value).replace(/^'/, "")
    })
    if (Object.values(cells).some((v) => v && v.trim() !== "")) records.push({ rowNumber, cells })
  })
  if (records.length > 5000) {
    return { ok: false, error: "The sheet has more than 5,000 rows. Split it into smaller sheets." }
  }
  return { ok: true, records }
}

/** "COGS / Unit ✎" and "cogs/unit" are the same heading. */
function headerKey(value: string): string {
  return value.replace(/✎/g, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase()
}

/** What a person sees in the cell, as text. Numbers keep Excel's own digits. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return value
  if (typeof value === "boolean") return String(value)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue)
    if ("richText" in value) return value.richText.map((p) => p.text).join("")
    if ("text" in value && typeof value.text === "string") return value.text
  }
  return ""
}
