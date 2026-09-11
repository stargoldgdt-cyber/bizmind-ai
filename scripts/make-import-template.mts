/**
 * Generates the BizMind import templates.
 *
 * Run with:  npm run template
 *
 * WHY THIS IS GENERATED AND NOT HAND-DRAWN
 * ----------------------------------------
 * The column headings come from `ENTITIES` in the ingestion service — the same
 * definitions the import wizard matches against. A hand-made spreadsheet would
 * drift the moment a field was renamed, and the person who found out would be
 * a customer whose import failed.
 *
 * Every heading below is a real alias the matcher already recognises, so a file
 * filled in from these templates maps itself with nothing to correct.
 *
 * THE SAMPLE ROWS ARE DELIBERATELY IMPERFECT
 * ------------------------------------------
 * One order has no cost and one has no fee. That is not sloppiness — it is the
 * fastest way to see BizMind's central behaviour: cost coverage drops below
 * 100%, profit is marked as overstated, and the margin alert refuses to fire on
 * a figure it cannot trust. A clean sample would hide the thing worth testing.
 */

import { mkdirSync, writeFileSync } from "node:fs"

import ExcelJS from "exceljs"

import { ENTITY_LIST } from "../src/services/ingestion/entities"

/**
 * ONE FILE PER ENTITY, EACH WITH EXACTLY ONE SHEET.
 *
 * `parseXlsx()` reads `workbook.worksheets[0]` and offers no way to choose a
 * sheet. A single workbook with an Orders tab, a Products tab and a read-me
 * would therefore import whichever tab happened to be first — and if that were
 * the read-me, the upload would fail with "no column headings found" and the
 * owner would have no idea why.
 *
 * So the guidance lives in a text file beside the templates, and every
 * workbook here contains data and nothing else.
 */
const OUT_DIR = "templates"

/**
 * Headings are the field's own label, always.
 *
 * An earlier version kept a hand-written map from field key to heading. It was
 * keyed by field key alone, and two entities share keys with different
 * meanings — `external_id` is "Order ID" on an order and "Reference" on an
 * expense — so the expenses template shipped with a column called "Order ID".
 *
 * `suggestMapping()` always includes the field's own label among its aliases,
 * so using the label is both correct by construction and impossible to get
 * out of step. The map is gone rather than fixed.
 */
/**
 * Sample rows.
 *
 * One order spans two lines (ORD-1002) to show that order-level values repeat
 * across the lines of the same order — the shape the pipeline expects, and the
 * one people most often get wrong.
 */
const ORDER_ROWS = [
  {
    external_id: "ORD-1001",
    placed_at: "2026-08-04",
    total: "1250.00",
    fee_total: "125.00",
    quantity: "2",
    unit_cost: "380.00",
    sku: "SHIRT-BLU-M",
    order_number: "1001",
    status: "FULFILLED",
    customer_email: "amina@example.com",
    customer_name: "Amina Rahman",
    currency: "AED",
    subtotal: "1200.00",
    discount_total: "0.00",
    tax_total: "50.00",
    shipping_total: "0.00",
    product_name: "Cotton Shirt — Blue, M",
    unit_price: "600.00",
    line_total: "1200.00",
  },
  {
    external_id: "ORD-1002",
    placed_at: "2026-08-09",
    total: "2140.00",
    fee_total: "214.00",
    quantity: "1",
    unit_cost: "900.00",
    sku: "BAG-LTH-01",
    order_number: "1002",
    status: "FULFILLED",
    customer_email: "omar@example.com",
    customer_name: "Omar Haddad",
    currency: "AED",
    subtotal: "2040.00",
    discount_total: "60.00",
    tax_total: "100.00",
    shipping_total: "60.00",
    product_name: "Leather Bag",
    unit_price: "1800.00",
    line_total: "1800.00",
  },
  {
    // Second line of the SAME order. Order-level values repeat exactly.
    external_id: "ORD-1002",
    placed_at: "2026-08-09",
    total: "2140.00",
    fee_total: "214.00",
    quantity: "1",
    unit_cost: "110.00",
    sku: "SCARF-SLK-RD",
    order_number: "1002",
    status: "FULFILLED",
    customer_email: "omar@example.com",
    customer_name: "Omar Haddad",
    currency: "AED",
    subtotal: "2040.00",
    discount_total: "60.00",
    tax_total: "100.00",
    shipping_total: "60.00",
    product_name: "Silk Scarf — Red",
    unit_price: "240.00",
    line_total: "240.00",
  },
  {
    // NO UNIT COST. Cost coverage will drop below 100% and BizMind will say so.
    external_id: "ORD-1003",
    placed_at: "2026-08-17",
    total: "480.00",
    fee_total: "48.00",
    quantity: "3",
    unit_cost: "",
    sku: "MUG-CER-WT",
    order_number: "1003",
    status: "FULFILLED",
    customer_email: "amina@example.com",
    customer_name: "Amina Rahman",
    currency: "AED",
    subtotal: "480.00",
    discount_total: "0.00",
    tax_total: "0.00",
    shipping_total: "0.00",
    product_name: "Ceramic Mug — White",
    unit_price: "160.00",
    line_total: "480.00",
  },
  {
    // NO FEE. Left blank, never zero — a blank means unknown.
    external_id: "ORD-1004",
    placed_at: "2026-08-23",
    total: "3600.00",
    fee_total: "",
    quantity: "2",
    unit_cost: "1250.00",
    sku: "JACKET-WOOL-L",
    order_number: "1004",
    status: "FULFILLED",
    customer_email: "sara@example.com",
    customer_name: "Sara Nasser",
    currency: "AED",
    subtotal: "3600.00",
    discount_total: "0.00",
    tax_total: "0.00",
    shipping_total: "0.00",
    product_name: "Wool Jacket — L",
    unit_price: "1800.00",
    line_total: "3600.00",
  },
  {
    // Cancelled: excluded from every figure, and counted separately.
    external_id: "ORD-1005",
    placed_at: "2026-08-27",
    total: "890.00",
    fee_total: "0.00",
    quantity: "1",
    unit_cost: "300.00",
    sku: "SHIRT-BLU-M",
    order_number: "1005",
    status: "CANCELLED",
    customer_email: "omar@example.com",
    customer_name: "Omar Haddad",
    currency: "AED",
    subtotal: "890.00",
    discount_total: "0.00",
    tax_total: "0.00",
    shipping_total: "0.00",
    product_name: "Cotton Shirt — Blue, M",
    unit_price: "890.00",
    line_total: "890.00",
  },
]

const PRODUCT_ROWS = [
  { sku: "SHIRT-BLU-M", name: "Cotton Shirt — Blue, M", unit_cost: "380.00", unit_price: "600.00", category: "Apparel", brand: "Northwind", barcode: "5012345678900", opening_stock: "42", reorder_point: "10" },
  { sku: "BAG-LTH-01", name: "Leather Bag", unit_cost: "900.00", unit_price: "1800.00", category: "Accessories", brand: "Northwind", barcode: "5012345678917", opening_stock: "8", reorder_point: "4" },
  { sku: "SCARF-SLK-RD", name: "Silk Scarf — Red", unit_cost: "110.00", unit_price: "240.00", category: "Accessories", brand: "Northwind", barcode: "5012345678924", opening_stock: "25", reorder_point: "8" },
  { sku: "MUG-CER-WT", name: "Ceramic Mug — White", unit_cost: "45.00", unit_price: "160.00", category: "Homeware", brand: "Kiln & Co", barcode: "5012345678931", opening_stock: "60", reorder_point: "20" },
  { sku: "JACKET-WOOL-L", name: "Wool Jacket — L", unit_cost: "1250.00", unit_price: "1800.00", category: "Apparel", brand: "Northwind", barcode: "5012345678948", opening_stock: "12", reorder_point: "5" },
]

const EXPENSE_ROWS = [
  { incurred_at: "2026-08-01", amount: "4500.00", category: "Rent", description: "Warehouse rent, August", vendor: "Gulf Properties", external_id: "INV-8801", currency: "AED" },
  { incurred_at: "2026-08-06", amount: "1800.00", category: "Advertising", description: "Search ads", vendor: "Ad Platform", external_id: "INV-8802", currency: "AED" },
  { incurred_at: "2026-08-14", amount: "950.00", category: "Shipping", description: "Courier account top-up", vendor: "SwiftShip", external_id: "INV-8803", currency: "AED" },
  { incurred_at: "2026-08-21", amount: "600.00", category: "Software", description: "Accounting subscription", vendor: "LedgerCloud", external_id: "INV-8804", currency: "AED" },
]

const SAMPLES: Record<string, Record<string, string>[]> = {
  ORDERS: ORDER_ROWS,
  PRODUCTS: PRODUCT_ROWS,
  EXPENSES: EXPENSE_ROWS,
}


/**
 * The instructions, as a plain text file beside the workbooks.
 *
 * Not a sheet inside them: see the note on OUT_DIR above.
 */
const GUIDE = `BIZMIND — HOW TO IMPORT
=======================

Three templates, one per kind of data. Import ONE file at a time and pick the
matching type in the wizard.

  bizmind-orders-template.xlsx     -> "Sales / Orders"
  bizmind-products-template.xlsx   -> "Products"
  bizmind-expenses-template.xlsx   -> "Expenses"

Each file has ONE sheet. Do not add more sheets: BizMind reads the first sheet
only. .xlsx and .csv are both accepted.


ONE ROW PER ORDER LINE
----------------------
If an order contains three products, it gets three rows, and the order-level
columns (Order ID, Order date, Order total, Channel fees) REPEAT identically on
all three. Order ORD-1002 in the sample shows this.

BizMind groups rows into orders by Order ID, so getting this wrong is the one
mistake that changes your revenue.


LEAVE BLANKS BLANK
------------------
Never type 0 for something you do not know.

A blank stays unknown. A zero is a claim -- that a product cost nothing, or that
a marketplace charged no fee -- and BizMind would believe you. Blank cells are
reported as gaps; zeros quietly inflate your profit.


CHANNEL IS CHOSEN PER FILE
--------------------------
There is no channel column. You pick the channel in the wizard, and it applies
to the whole file.

To compare Amazon against your website, export one file per channel and import
each separately, choosing the right channel each time. That is what makes the
Channels page work.


UNIT COST
---------
This is the only way to record what a sale cost you.

BizMind will NOT take the cost from your product list, because that is today's
price and a past sale had a different one. Re-pricing a product can never move
last month's profit.

Without unit cost, gross profit and margin are overstated -- BizMind will say so
rather than hide it.


CURRENCY AND DATES
------------------
Currency must match your business currency. Nothing is converted.

Dates can be 2026-08-04, a real Excel date cell, or your own format chosen in
the wizard. If your dates are ambiguous (03/04/2026), pick the right format --
BizMind will not guess, because guessing moves transactions between months.


THE SAMPLE DATA IS IMPERFECT ON PURPOSE
---------------------------------------
In the orders template:

  ORD-1003 has no unit cost
  ORD-1004 has no channel fee
  ORD-1005 is CANCELLED

After importing you should see:

  - cost coverage below 100%, naming how many lines are missing a cost
  - gross profit and margin marked as overstated
  - the cancelled order excluded from revenue and counted separately
  - a margin alert that REFUSES to fire, because the figure cannot be trusted

That is BizMind working correctly. Delete the sample rows before importing your
own data.


HOVER A COLUMN HEADING
----------------------
Every heading carries a note explaining what it is, whether it is required, and
what you lose without it.
`

/* ---- One sheet per entity ------------------------------------------------ */

mkdirSync(OUT_DIR, { recursive: true })

const written: string[] = []

for (const entity of ENTITY_LIST) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = "BizMind AI"
  workbook.created = new Date()

  const sheet = workbook.addWorksheet(entity.label.replace(/[/\\?*[\]:]/g, " ").slice(0, 31))

  const fields = [...entity.fields].sort((a, b) => {
    const order = { required: 0, recommended: 1, optional: 2 } as const
    return order[a.importance] - order[b.importance]
  })

  const headings = fields.map((field) => field.label)
  sheet.addRow(headings)

  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.height = 22
  header.eachCell((cell, index) => {
    const field = fields[index - 1]

    // Required columns are tinted, so a missing one is visible before upload
    // rather than at the mapping step.
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb:
          field.importance === "required"
            ? "FFEDE7FE"
            : field.importance === "recommended"
              ? "FFF5F3FB"
              : "FFFFFFFF",
      },
    }
    cell.border = { bottom: { style: "thin", color: { argb: "FFD9D4EC" } } }

    const consequence = field.consequence ? `\n\n${field.consequence}` : ""
    cell.note = `${field.importance.toUpperCase()}\n\n${field.help ?? field.label}${consequence}`
  })

  for (const sample of SAMPLES[entity.key] ?? []) {
    sheet.addRow(fields.map((field) => sample[field.key] ?? ""))
  }

  sheet.columns.forEach((column, index) => {
    column.width = Math.min(Math.max((headings[index]?.length ?? 10) + 4, 12), 26)
  })

  sheet.views = [{ state: "frozen", ySplit: 1 }]

  const file = `${OUT_DIR}/bizmind-${entity.key.toLowerCase()}-template.xlsx`
  await workbook.xlsx.writeFile(file)
  written.push(
    `${file} — ${entity.fields.length} columns, ${(SAMPLES[entity.key] ?? []).length} sample rows`
  )
}

writeFileSync(`${OUT_DIR}/HOW-TO-IMPORT.txt`, GUIDE, "utf8")

console.log(`Wrote ${written.length + 1} files into ${OUT_DIR}/`)
for (const line of written) console.log(`  ${line}`)
console.log(`  ${OUT_DIR}/HOW-TO-IMPORT.txt`)
console.log("\nHeadings come from src/services/ingestion/entities.ts, so they")
console.log("match what the import wizard recognises.")
