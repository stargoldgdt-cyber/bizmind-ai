/**
 * Verification for file parsing — the CSV and XLSX readers.
 *
 * Run with:  npm run test:parse
 *
 * Excel is the case that matters most here: a date in a spreadsheet is a real
 * Date object, not text, so it arrives unambiguous. Proving that end to end is
 * what makes ".xlsx" a genuinely supported format rather than a checkbox.
 */

import ExcelJS from "exceljs"

import type { ImportOptions } from "@/services/ingestion/contracts"
import { getEntity } from "@/services/ingestion/entities"
import { suggestMapping } from "@/services/ingestion/mapping"
import { parseFile } from "@/services/ingestion/parse"
import { validate } from "@/services/ingestion/validate"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

const options: ImportOptions = {
  dateFormat: "auto",
  decimalSeparator: ".",
  source: "SHOPIFY",
}

/* ========================================================================== */
section("1. CSV parsing")

const csv = `Order ID,Order Date,Total,Fees,SKU,Qty,Unit Cost
CSV-1,2026-04-01,"1,234.56",98.76,SKU-X,3,"1,000.00"
CSV-2,2026-04-02,500.00,0,SKU-Y,1,200
`

const csvParsed = await parseFile(Buffer.from(csv, "utf8"), "orders.csv")
if ("error" in csvParsed) {
  check("CSV parsed", false, csvParsed.error)
} else {
  check("CSV parsed", true)
  check("7 columns detected", csvParsed.columns.length === 7, String(csvParsed.columns.length))
  check("2 data rows", csvParsed.rows.length === 2)
  check(
    "quoted value containing a comma kept whole",
    csvParsed.rows[0]["Total"] === "1,234.56",
    String(csvParsed.rows[0]["Total"])
  )

  const orders = getEntity("ORDERS")
  const mapping = suggestMapping(orders, csvParsed.columns)
  const result = validate(orders, csvParsed.rows, mapping, options, "BDT")

  check("both orders valid", result.validRowCount === 2)
  check(
    "THOUSANDS SEPARATOR: 1,234.56 became 1234.56",
    (result.rows[0] as { total: string }).total === "1234.56",
    (result.rows[0] as { total: string }).total
  )
  check(
    "THOUSANDS SEPARATOR in cost: 1,000.00 became 1000.00",
    (result.rows[0] as { items: { unit_cost: string | null }[] }).items[0].unit_cost === "1000.00",
    String((result.rows[0] as { items: { unit_cost: string | null }[] }).items[0].unit_cost)
  )
}

/* ========================================================================== */
section("2. UTF-8 byte order mark (what Excel writes when saving as CSV)")

const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, "utf8")])
const bomParsed = await parseFile(bom, "orders-bom.csv")
check(
  "BOM stripped so the first column name is clean",
  !("error" in bomParsed) && bomParsed.columns[0] === "Order ID",
  "error" in bomParsed ? bomParsed.error : bomParsed.columns[0]
)

/* ========================================================================== */
section("3. XLSX parsing — real Excel dates and formulas")

const workbook = new ExcelJS.Workbook()
const sheet = workbook.addWorksheet("Sales")
sheet.addRow(["Order ID", "Order Date", "Total", "Fees", "SKU", "Qty", "Unit Cost"])
// A genuine Date cell — the case that would be ambiguous as text.
sheet.addRow(["XL-1", new Date(Date.UTC(2026, 3, 5)), 1500, 120, "SKU-Z", 2, 400])
sheet.addRow(["XL-2", new Date(Date.UTC(2026, 3, 6)), 999.99, 0, "SKU-W", 1, 250])
// A formula cell: the computed result must be used, not the formula text.
const formulaRow = sheet.addRow(["XL-3", new Date(Date.UTC(2026, 3, 7)), 0, 0, "SKU-V", 1, 100])
formulaRow.getCell(3).value = { formula: "100*3", result: 300 }

const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer())
const xlsxParsed = await parseFile(xlsxBuffer, "sales.xlsx")

if ("error" in xlsxParsed) {
  check("XLSX parsed", false, xlsxParsed.error)
} else {
  check("XLSX parsed", true)
  check("3 data rows", xlsxParsed.rows.length === 3, String(xlsxParsed.rows.length))
  check(
    "date cell arrives as a real Date, not text",
    xlsxParsed.rows[0]["Order Date"] instanceof Date
  )
  check(
    "formula cell resolved to its result",
    xlsxParsed.rows[2]["Total"] === 300,
    String(xlsxParsed.rows[2]["Total"])
  )

  const orders = getEntity("ORDERS")
  const mapping = suggestMapping(orders, xlsxParsed.columns)
  const result = validate(orders, xlsxParsed.rows, mapping, options, "BDT")

  check("all three orders valid", result.validRowCount === 3, String(result.validRowCount))
  check(
    "Excel date read as 5 April 2026 with NO format guess needed",
    (result.rows[0] as { placed_at: string }).placed_at.startsWith("2026-04-05"),
    (result.rows[0] as { placed_at: string }).placed_at
  )
  check(
    "formula result carried into the order total",
    (result.rows[2] as { total: string }).total === "300"
  )
}

/* ========================================================================== */
section("4. Files that should be refused")

const empty = await parseFile(Buffer.from("", "utf8"), "empty.csv")
check("empty file refused", "error" in empty)

const badExt = await parseFile(Buffer.from("hello", "utf8"), "notes.docx")
check(
  "unsupported extension refused by name",
  "error" in badExt && badExt.error.includes(".docx"),
  "error" in badExt ? badExt.error : ""
)

const badPdf = await parseFile(Buffer.from("not a real pdf", "utf8"), "notes.pdf")
check(
  "an unreadable PDF is refused with its own message, not the 'unsupported extension' one",
  "error" in badPdf && badPdf.error.startsWith("That PDF could not be read"),
  "error" in badPdf ? badPdf.error : ""
)

const headerOnly = await parseFile(Buffer.from("A,B,C\n", "utf8"), "headers.csv")
check(
  "headings with no data rows produce zero rows",
  !("error" in headerOnly) && headerOnly.rows.length === 0
)

const notXlsx = await parseFile(Buffer.from("this is not a workbook", "utf8"), "fake.xlsx")
check("corrupt xlsx refused with a readable message", "error" in notXlsx)

/* ========================================================================== */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
