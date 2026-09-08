/**
 * Verification for the import pipeline's pure logic.
 *
 * Run with:  npm run test:import
 *
 * These are the cases where a mistake would silently corrupt a business
 * figure — ambiguous dates, European number formats, foreign currencies,
 * duplicate rows that disagree. Every one is asserted rather than eyeballed.
 */

import Papa from "papaparse"

import type { ImportOptions, RawRecord } from "@/services/ingestion/contracts"
import { getEntity } from "@/services/ingestion/entities"
import { suggestMapping } from "@/services/ingestion/mapping"
import { normalizeDate, normalizeDecimal } from "@/services/ingestion/normalize"
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

function rowsFrom(csv: string): RawRecord[] {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  })
  return parsed.data
}

const baseOptions: ImportOptions = {
  dateFormat: "auto",
  decimalSeparator: ".",
  source: "AMAZON",
}

/* ========================================================================== */
section("1. NUMBERS — never parsed with floating point")

check(
  "plain decimal",
  (normalizeDecimal("1234.56", ".") as { value: string }).value === "1234.56"
)
check(
  "thousands separators stripped",
  (normalizeDecimal("1,234,567.89", ".") as { value: string }).value === "1234567.89"
)
check(
  "currency symbol stripped",
  (normalizeDecimal("$1,299.00", ".") as { value: string }).value === "1299.00"
)
check(
  "European format with comma decimal",
  (normalizeDecimal("1.234,56", ",") as { value: string }).value === "1234.56"
)
check(
  "accounting negative in parentheses",
  (normalizeDecimal("(500.25)", ".", { allowNegative: true }) as { value: string }).value ===
    "-500.25"
)
check("negative rejected where not allowed", normalizeDecimal("-5", ".").ok === false)
check("text rejected", normalizeDecimal("not a number", ".").ok === false)
check("empty rejected", normalizeDecimal("", ".").ok === false)
check(
  "wrong separator for chosen format is rejected, not reinterpreted",
  normalizeDecimal("1,234.56", ",").ok === false
)
check(
  "precision beyond float safety is preserved as text",
  (normalizeDecimal("9007199254740993.75", ".") as { value: string }).value ===
    "9007199254740993.75"
)

/* ========================================================================== */
section("2. DATES — ambiguity is refused, never guessed")

check(
  "ISO accepted",
  (normalizeDate("2026-03-04", "auto") as { value: string }).value.startsWith("2026-03-04")
)
check(
  "unambiguous DMY detected (day > 12)",
  (normalizeDate("25/12/2026", "auto") as { value: string }).value.startsWith("2026-12-25")
)
check(
  "unambiguous MDY detected (month position > 12 impossible)",
  (normalizeDate("12/25/2026", "auto") as { value: string }).value.startsWith("2026-12-25")
)
check(
  "AMBIGUOUS date REFUSED in auto mode",
  normalizeDate("03/04/2026", "auto").ok === false,
  "03/04 could be 3 April or 4 March"
)
check(
  "same date accepted once the user states DMY",
  (normalizeDate("03/04/2026", "DMY") as { value: string }).value.startsWith("2026-04-03")
)
check(
  "same date reads differently under MDY — proving it mattered",
  (normalizeDate("03/04/2026", "MDY") as { value: string }).value.startsWith("2026-03-04")
)
check("impossible date rejected", normalizeDate("31/02/2026", "DMY").ok === false)
check("garbage rejected", normalizeDate("not a date", "auto").ok === false)
check(
  "Excel serial number converted",
  (normalizeDate(46023, "auto") as { value: string }).value.startsWith("2026-01-01")
)

/* ========================================================================== */
section("3. COLUMN MAPPING — suggestions from real-world headers")

const orders = getEntity("ORDERS")
const suggested = suggestMapping(
  orders,
  ["Order ID", "Order Date", "Total Amount", "Commission", "SKU", "Qty", "Cost Price", "Buyer Email"]
)
check("Order ID mapped", suggested.external_id === "Order ID")
check("Order Date mapped", suggested.placed_at === "Order Date")
check("Total Amount mapped", suggested.total === "Total Amount")
check("Commission mapped to channel fees", suggested.fee_total === "Commission")
check("Qty mapped to quantity", suggested.quantity === "Qty")
check("Cost Price mapped to unit cost", suggested.unit_cost === "Cost Price")
check("Buyer Email mapped to customer email", suggested.customer_email === "Buyer Email")

/* ========================================================================== */
section("4. VALID FILE — figures verified by hand")

const validCsv = `
Order ID,Order Date,Total,Fees,SKU,Qty,Unit Cost,Unit Price,Email
ORD-1,2026-01-15,1200.00,96.00,SKU-A,2,300.00,600.00,ana@example.com
ORD-2,2026-01-16,450.50,36.04,SKU-B,1,200.00,450.50,ben@example.com
ORD-3,2026-01-17,780.00,0.00,SKU-A,3,300.00,260.00,ana@example.com
`

const validMapping = {
  external_id: "Order ID",
  placed_at: "Order Date",
  total: "Total",
  fee_total: "Fees",
  sku: "SKU",
  quantity: "Qty",
  unit_cost: "Unit Cost",
  unit_price: "Unit Price",
  customer_email: "Email",
}

const validResult = validate(orders, rowsFrom(validCsv), validMapping, baseOptions, "BDT")

check("3 orders read", validResult.validRowCount === 3)
check("0 rows failed", validResult.failedRowCount === 0)
check("not blocked", validResult.blocked === false)
check("no missing recommended fields", validResult.missingRecommended.length === 0)

const totals = validResult.rows as { total: string; fee_total?: string; items: { quantity: string; unit_cost: string | null }[] }[]
const revenue = totals.reduce((sum, o) => sum + Number(o.total), 0)
const fees = totals.reduce((sum, o) => sum + Number(o.fee_total ?? 0), 0)
const cogs = totals.reduce(
  (sum, o) => sum + o.items.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_cost ?? 0), 0),
  0
)

check("revenue 1200 + 450.50 + 780 = 2430.50", revenue === 2430.5, `got ${revenue}`)
check("fees 96 + 36.04 + 0 = 132.04", Math.abs(fees - 132.04) < 0.0001, `got ${fees}`)
check(
  "COGS (2x300) + (1x200) + (3x300) = 1700",
  cogs === 1700,
  `got ${cogs}`
)
check(
  "gross profit 2430.50 - 1700 - 132.04 = 598.46",
  Math.abs(revenue - cogs - fees - 598.46) < 0.0001
)

/* ========================================================================== */
section("5. MISSING REQUIRED COLUMN — blocked, not guessed")

const noTotal = validate(
  orders,
  rowsFrom(validCsv),
  { external_id: "Order ID", placed_at: "Order Date" },
  baseOptions,
  "BDT"
)
check("import blocked", noTotal.blocked === true)
check("nothing normalised", noTotal.rows.length === 0)
check(
  "reason names the missing column",
  (noTotal.blockedReason ?? "").includes("Order total"),
  noTotal.blockedReason
)

/* ========================================================================== */
section("6. MISSING RECOMMENDED COLUMN — allowed, but surfaced")

const noCost = validate(
  orders,
  rowsFrom(validCsv),
  { external_id: "Order ID", placed_at: "Order Date", total: "Total", sku: "SKU", quantity: "Qty" },
  baseOptions,
  "BDT"
)
check("still imports", noCost.blocked === false && noCost.validRowCount === 3)
const missingKeys = noCost.missingRecommended.map((m) => m.field)
check("unit cost flagged", missingKeys.includes("unit_cost"))
check("channel fees flagged", missingKeys.includes("fee_total"))
check(
  "consequence explains profit will be overstated",
  noCost.missingRecommended.some((m) => m.consequence.toUpperCase().includes("OVERSTATED"))
)

/* ========================================================================== */
section("7. BAD DATA — reported row by row, good rows still import")

const messyCsv = `
Order ID,Order Date,Total,Fees,SKU,Qty,Unit Cost
ORD-10,2026-01-15,1000.00,50,SKU-A,2,100
ORD-11,not-a-date,500.00,10,SKU-B,1,50
ORD-12,2026-01-17,abc,10,SKU-C,1,50
,2026-01-18,300.00,10,SKU-D,1,50
ORD-14,2026-01-19,700.00,10,SKU-E,0,50
`
const messy = validate(orders, rowsFrom(messyCsv), validMapping, baseOptions, "BDT")

check("only the one good row imports", messy.validRowCount === 1, `got ${messy.validRowCount}`)
check("four rows failed", messy.failedRowCount === 4, `got ${messy.failedRowCount}`)
check("bad date reported", messy.issues.some((i) => i.field === "placed_at"))
check("bad number reported", messy.issues.some((i) => i.field === "total"))
check("empty order id reported", messy.issues.some((i) => i.field === "external_id"))
check("zero quantity reported", messy.issues.some((i) => i.field === "quantity"))
check(
  "issues carry row numbers matching the spreadsheet",
  messy.issues.every((i) => i.rowNumber >= 2)
)

/* ========================================================================== */
section("8. DUPLICATES — same order over several lines")

const multiLine = `
Order ID,Order Date,Total,Fees,SKU,Qty,Unit Cost
ORD-20,2026-02-01,900.00,72,SKU-A,2,100
ORD-20,2026-02-01,900.00,72,SKU-B,1,300
`
const grouped = validate(orders, rowsFrom(multiLine), validMapping, baseOptions, "BDT")
check("two lines become ONE order", grouped.validRowCount === 1)
check(
  "both lines attached",
  (grouped.rows[0] as { items: unknown[] }).items.length === 2
)

const conflicting = `
Order ID,Order Date,Total,Fees,SKU,Qty,Unit Cost
ORD-30,2026-02-01,900.00,72,SKU-A,2,100
ORD-30,2026-02-01,950.00,72,SKU-B,1,300
`
const conflict = validate(orders, rowsFrom(conflicting), validMapping, baseOptions, "BDT")
check("conflicting totals rejected, not averaged or overwritten", conflict.failedRowCount === 1)
check(
  "the conflict is explained",
  conflict.issues.some((i) => i.message.includes("will not")),
  conflict.issues[0]?.message
)

/* ========================================================================== */
section("9. CURRENCY — checked, never converted")

const foreignCsv = `
Order ID,Order Date,Total,Currency,SKU,Qty,Unit Cost
ORD-40,2026-02-01,100.00,USD,SKU-A,1,50
`
const foreign = validate(
  orders,
  rowsFrom(foreignCsv),
  { ...validMapping, currency: "Currency" },
  baseOptions,
  "BDT"
)
check("foreign-currency row refused", foreign.failedRowCount === 1)
check(
  "message explains no conversion is performed",
  foreign.issues.some((i) => i.message.includes("does not convert")),
  foreign.issues[0]?.message
)

const matchingCsv = foreignCsv.replace("USD", "BDT")
const matching = validate(
  orders,
  rowsFrom(matchingCsv),
  { ...validMapping, currency: "Currency" },
  baseOptions,
  "BDT"
)
check("matching currency accepted", matching.validRowCount === 1)

/* ========================================================================== */
section("10. AMBIGUOUS DATES INSIDE A REAL FILE")

const ambiguousCsv = `
Order ID,Order Date,Total,Fees,SKU,Qty,Unit Cost
ORD-50,05/06/2026,100.00,5,SKU-A,1,50
`
const ambiguous = validate(orders, rowsFrom(ambiguousCsv), validMapping, baseOptions, "BDT")
check("row refused while the format is unstated", ambiguous.failedRowCount === 1)
check(
  "the user is told to choose a format",
  ambiguous.issues.some((i) => i.message.includes("Choose a date format"))
)

const resolved = validate(orders, rowsFrom(ambiguousCsv), validMapping, { ...baseOptions, dateFormat: "DMY" }, "BDT")
check("accepted once the format is stated", resolved.validRowCount === 1)
check(
  "interpreted as 5 June",
  (resolved.rows[0] as { placed_at: string }).placed_at.startsWith("2026-06-05")
)

/* ========================================================================== */
section("11. PRODUCTS AND EXPENSES")

const productsCsv = `
SKU,Product Name,Cost,Price,Category,Stock
SKU-A,Cotton Shirt,300.00,600.00,Apparel,40
SKU-B,Silk Scarf,200.00,450.00,Accessories,15
SKU-A,Cotton Shirt v2,320.00,620.00,Apparel,35
`
const products = getEntity("PRODUCTS")
const productResult = validate(
  products,
  rowsFrom(productsCsv),
  { sku: "SKU", name: "Product Name", unit_cost: "Cost", unit_price: "Price", category: "Category", opening_stock: "Stock" },
  baseOptions,
  "BDT"
)
check("duplicate SKU collapses to one product", productResult.validRowCount === 2)
check("duplicate reported as a warning", productResult.issues.some((i) => i.severity === "WARNING"))

const expensesCsv = `
Date,Amount,Category,Description
2026-01-05,15000.00,Rent,January rent
2026-01-09,-50.00,Refund,Negative should fail
2026-01-10,3200.50,Marketing,Facebook ads
`
const expenses = getEntity("EXPENSES")
const expenseResult = validate(
  expenses,
  rowsFrom(expensesCsv),
  { incurred_at: "Date", amount: "Amount", category: "Category", description: "Description" },
  baseOptions,
  "BDT"
)
check("two valid expenses", expenseResult.validRowCount === 2)
check("negative amount refused", expenseResult.failedRowCount === 1)
check(
  "expense total 15000 + 3200.50 = 18200.50",
  (expenseResult.rows as { amount: string }[]).reduce((s, e) => s + Number(e.amount), 0) === 18200.5
)

/* ========================================================================== */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
