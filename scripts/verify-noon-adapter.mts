/**
 * The noon adapter, offline (GCC Phase 5).
 *
 * Run with:  npm run test:noon   (part of npm run verify)
 *
 * Invented rows only -- the owner's real files never enter the repository.
 */

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

import { classificationMatchKey } from "../src/services/classification/model"
import { LEDGER_CATEGORIES, type MappingRuleSummary, type SourceRow } from "../src/services/marketplaces/contract"
import { isCustomerDataColumn } from "../src/services/marketplaces/customer-data"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import { noonAdapter } from "../src/services/marketplaces/noon/adapter"
import { NOON_INVOICE_HEADERS, noonInvoicesFormat } from "../src/services/marketplaces/noon/invoices"
import {
  NOON_INVOICES_FORMAT_ID,
  NOON_RULES,
  NOON_TV_FORMAT_ID,
} from "../src/services/marketplaces/noon/rules"
import { NOON_TV_HEADERS, noonTransactionViewFormat } from "../src/services/marketplaces/noon/transaction-view"
import { createAdapterRegistry } from "../src/services/marketplaces/registry"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`)
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

const rules: MappingRuleSummary[] = NOON_RULES.map((r) => ({
  id: randomUUID(),
  matchKey: r.matchKey,
  side: r.side,
  category: r.importCategory,
  subcategory: r.importSubcategory,
  attribution: r.attribution,
  quantityRule: r.quantityRule,
  signRule: "AS_REPORTED",
}))
const ruleById = new Map(rules.map((rule, index) => [rule.id, NOON_RULES[index]]))
const account = { id: randomUUID(), marketplaceCode: "NOON", currency: "AED" }

/* ---- invented rows -------------------------------------------------------- */

const MONEY_TV = new Set([
  "Net Proceeds", "Referral Fee including VAT", "Fullfilment & Logistics Fees including VAT",
  "Shipping Credits including VAT", "Other Order Fees including VAT", "Order Subsidies including VAT",
  "Non-Order Fees including VAT", "Non-Order Subsidies including VAT", "Others including VAT", "Total",
])

let rowNumber = 1
function tv(fields: Partial<Record<(typeof NOON_TV_HEADERS)[number], string>>): SourceRow {
  rowNumber += 1
  const raw: Record<string, string | null> = {}
  for (const header of NOON_TV_HEADERS) raw[header] = fields[header] ?? (MONEY_TV.has(header) ? "0" : "")
  return { rowNumber, raw }
}
const base = {
  Contract: "MPTESTAE", "Contract Title": "NOON-AE", "Transaction Date": "2026-07-04", Currency: "AED",
} as const

function inv(fields: Partial<Record<(typeof NOON_INVOICE_HEADERS)[number], string>>): SourceRow {
  rowNumber += 1
  const raw: Record<string, string | null> = {}
  for (const header of NOON_INVOICE_HEADERS) raw[header] = fields[header] ?? ""
  return { rowNumber, raw }
}
const fee = (name: string, vat: string, included: string, documentType = "Invoice") =>
  inv({
    "Document Type": documentType, "Transaction Type": "Statement Fee", "Document Date": "2026-07-08",
    Description: `PS-1-AE20260708 : ${name}`, "Document Currency": "AED", "VAT Amount (Document Currency)": vat,
    "Price Including VAT (Document Currency)": included, "Receiver Legal Name": "Invented Seller LLC",
    "Receiver TRN": "100000000000003", "Source Doc Line Nr": `PS-1-AE20260708/${name}`,
  })

/* -------------------------------------------------------------------------- */
section("1. RECOGNISING THE TWO REPORTS")

const detect = (headers: readonly string[]) => noonAdapter.detect({ fileName: "x.csv", headers, rows: [] })
const tvDetect = detect(NOON_TV_HEADERS)
check("the Transaction View is recognised exactly", tvDetect.kind === "match" && tvDetect.formatId === NOON_TV_FORMAT_ID && tvDetect.confidence === "exact")
const invDetect = detect([...NOON_INVOICE_HEADERS].reverse())
check("the Invoices and Credit Notes export is recognised in any column order", invDetect.kind === "match" && invDetect.formatId === NOON_INVOICES_FORMAT_ID)
check("a missing column means it is not the report", detect(NOON_TV_HEADERS.slice(1)).kind === "unknown")
check("an Amazon settlement is not a noon report", detect(["settlement-id", "amount", "posted-date-time"]).kind === "unknown")

const registry = createAdapterRegistry()
let registered = true
try {
  registry.register(noonAdapter)
} catch {
  registered = false
}
check("the registry accepts both formats (no customer column is stored)", registered)
check("the Transaction View stores no customer column", noonTransactionViewFormat.allowedColumns.every((c) => !isCustomerDataColumn(c)))
check(
  "the invoices never store a party's name, tax number, city, location or free text",
  ["Receiver Legal Name", "Receiver TRN", "Receiver City", "Receiver Location", "Receiver Country",
    "Issuer Legal Name", "Issuer TRN", "Issuer City", "Issuer Location", "Issuer Legal Entity",
    "Receiver Legal Entity", "Misc"].every((c) => !noonInvoicesFormat.allowedColumns.includes(c))
)

/* -------------------------------------------------------------------------- */
section("2. THE TRANSACTION VIEW, LINE BY LINE")

const tvRows = [
  tv({ ...base, "Order Nr": "NAEITEST1", "Item Nr": "NAEITEST1-1", "Partner SKUs": "SKU-A", "Transaction Type": "order",
    "Net Proceeds": "100", "Referral Fee including VAT": "-10.50", "Fullfilment & Logistics Fees including VAT": "-5.25",
    "Order Subsidies including VAT": "2", Total: "86.25" }),
  tv({ ...base, "Order Nr": "NAEITEST1", "Transaction Type": "order", "Fullfilment & Logistics Fees including VAT": "-3.15", Total: "-3.15" }),
  tv({ ...base, "Order Nr": "NAEITEST1", "Item Nr": "NAEITEST1-1", "Transaction Type": "order_update", "Net Proceeds": "-20",
    "Referral Fee including VAT": "2.10", Total: "-17.90" }),
  tv({ ...base, "Order Nr": "NA", Title: "Advertising Fee", "Transaction Type": "statement_fee",
    "Non-Order Fees including VAT": "-21", Total: "-21", "Reference Nr": "PS-1-AE20260708" }),
  tv({ ...base, "Order Nr": "NA", Title: "Payment Disbursal", "Transaction Type": "payment",
    "Others including VAT": "-60", Total: "-60", "Reference Nr": "2026-07-10 Bank Transfer" }),
  tv({ ...base, "Order Nr": "NA", Title: "MPTEST-2026-07-30", "Transaction Type": "balance_transfer",
    "Others including VAT": "-1", Total: "-1" }),
  tv({ ...base, Currency: "SAR", "Contract Title": "Noon SA (Origin AE)", "Order Nr": "NA", "Transaction Type": "balance_transfer",
    "Others including VAT": "-0.50", Total: "-0.50" }),
  tv({ ...base, "Order Nr": "NAEITEST2", "Item Nr": "NAEITEST2-1", "Transaction Type": "order", "Others including VAT": "-4", Total: "-4" }),
  tv({ ...base, "Order Nr": "NAEITEST3", "Transaction Type": "order", "Net Proceeds": "1,000.00", Total: "1000" }),
  tv({ ...base, "Order Nr": "NAEITEST4", "Transaction Type": "order", "Transaction Date": "31/07/2026", "Net Proceeds": "5", Total: "5" }),
  tv({ ...base, "Order Nr": "NAEITEST5", "Transaction Type": "order" }),
]
const tvResult = noonAdapter.normalize({ formatId: NOON_TV_FORMAT_ID, rows: tvRows, account, rules })
const linesOf = (row: SourceRow) => tvResult.transactions.filter((t) => t.sourceRowNumber === row.rowNumber)
const issuesOf = (row: SourceRow) => tvResult.issues.filter((i) => i.rowNumber === row.rowNumber)
const meaning = (t: { mappingRuleId: string | null }) => (t.mappingRuleId ? ruleById.get(t.mappingRuleId) : undefined)

const item = linesOf(tvRows[0])
check("an item row with four non-zero amounts becomes four lines (zeros are skipped)", item.length === 4, String(item.length))
check(
  "each is classified: sales, referral fee, fulfilment, subsidy",
  item.map((t) => meaning(t)?.category).join() === "PRODUCT_SALES,MARKETPLACE_FEE,FULFILLMENT,SUBSIDY_INCOME",
  item.map((t) => meaning(t)?.category).join()
)
check(
  "amounts are exactly as reported, signed from the seller's side",
  item.map((t) => t.amount).join() === "100,-10.50,-5.25,2"
)
check("the sale counts one derived unit", item[0].quantity === "1" && item[0].quantityBasis === "DERIVED_LINE_COUNT")
check("item rows are attributed to the order line", item.every((t) => t.attribution === "ORDER_LINE" && t.orderLineRef === "NAEITEST1-1"))
check("the date becomes that calendar day in UTC", item[0].postedAt === "2026-07-04T00:00:00Z")
check("the seller SKU and order are kept", item[0].rawSku === "SKU-A" && item[0].orderRef === "NAEITEST1")

const orderLevel = linesOf(tvRows[1])
check(
  "an order-level fee is attributed to the order",
  orderLevel.length === 1 && orderLevel[0].attribution === "ORDER" && orderLevel[0].sourceDescription === "order" &&
    meaning(orderLevel[0])?.category === "FULFILLMENT"
)

const update = linesOf(tvRows[2])
check(
  "an order update's proceeds count with sales, under review",
  meaning(update[0])?.category === "PRODUCT_SALES" && meaning(update[0])?.confidence === "MEDIUM" && update[0].amount === "-20"
)
check("its referral fee reversal keeps the fee category", meaning(update[1])?.category === "MARKETPLACE_FEE" && update[1].amount === "2.10")

const ad = linesOf(tvRows[3])
check(
  "a statement fee named Advertising Fee is advertising, with no order ('NA' is blank)",
  ad.length === 1 && meaning(ad[0])?.category === "ADVERTISING" && ad[0].orderRef === null && ad[0].attribution === "MARKETPLACE"
)

const payment = linesOf(tvRows[4])
const payout = tvResult.payouts[0]
check(
  "a payment is a payout of 60 (noon shows it as -60 leaving the balance)",
  tvResult.payouts.length === 1 && payout.amount === "60" && payout.paidAt === "2026-07-04T00:00:00Z" &&
    payout.externalRef === "2026-07-10 Bank Transfer"
)
check(
  "and a cash line pointing at that payout -- never revenue",
  payment.length === 1 && meaning(payment[0])?.category === "PAYOUT" && payment[0].payoutRef === payout.key
)

const transfer = linesOf(tvRows[5])
check(
  "a balance transfer is cash, under review, whatever its reference says",
  meaning(transfer[0])?.category === "TRANSFER" && meaning(transfer[0])?.confidence === "MEDIUM" &&
    transfer[0].sourceDescription === null
)

check(
  "a SAR row is not counted in an AED account; a warning says which account it belongs to",
  linesOf(tvRows[6]).length === 0 && issuesOf(tvRows[6]).length === 1 && issuesOf(tvRows[6])[0].severity === "WARNING" &&
    issuesOf(tvRows[6])[0].message.includes("SAR") && issuesOf(tvRows[6])[0].message.includes("Noon SA")
)

const unknown = linesOf(tvRows[7])
check(
  "an amount in a column BizMind has not seen for that row is kept as UNMAPPED, with a warning",
  unknown.length === 1 && unknown[0].category === "UNMAPPED" && unknown[0].mappingRuleId === null &&
    issuesOf(tvRows[7]).some((i) => i.severity === "WARNING")
)
check(
  "a thousands separator is refused, never guessed",
  linesOf(tvRows[8]).length === 0 && issuesOf(tvRows[8]).some((i) => i.severity === "ERROR" && i.field === "Net Proceeds")
)
check(
  "a date that is not YYYY-MM-DD is refused",
  linesOf(tvRows[9]).length === 0 && issuesOf(tvRows[9]).some((i) => i.severity === "ERROR" && i.field === "Transaction Date")
)
check(
  "a row of zeros is kept as a warning, with nothing recorded",
  linesOf(tvRows[10]).length === 0 && issuesOf(tvRows[10]).some((i) => i.severity === "WARNING")
)
check(
  "every row is accounted for",
  tvRows.every((row) => linesOf(row).length > 0 || issuesOf(row).length > 0)
)
check(
  "every classified line matches its rule by the engine's own key",
  tvResult.transactions.filter((t) => t.mappingRuleId).every((t) =>
    classificationMatchKey(t.sourceType, t.sourceSubtype, t.sourceDescription) === meaning(t)?.matchKey)
)

/* -------------------------------------------------------------------------- */
section("3. THE INVOICES: VAT TAKEN BACK OUT OF THE FEES")

const invRows = [
  fee("Referral Fee", "0.40", "8.40"),
  fee("Rebates & Discounts (Directship Outbound Fee)", "-0.20", "-4.20"),
  fee("Import VAT Recovery", "0", "1.00"),
  fee("Advertising Fee", "1.00", "21.00", "Creditnote"),
  fee("A Fee Nobody Has Seen", "0.10", "2.10"),
  inv({ "Document Type": "Invoice", "Transaction Type": "Customer", "Document Date": "2026-07-05", "Document Currency": "AED",
    "VAT Amount (Document Currency)": "4.76", "Price Including VAT (Document Currency)": "100", "Source Doc Nr": "NAEITEST1",
    "Receiver Legal Name": "Invented Buyer", "Receiver City": "Invented City", "Partner SKU": "SKU-A" }),
  inv({ "Document Type": "Creditnote", "Transaction Type": "Customer", "Document Date": "2026-07-06", "Document Currency": "AED",
    "VAT Amount (Document Currency)": "0.95", "Price Including VAT (Document Currency)": "20", "Source Doc Nr": "NAEITEST1" }),
  inv({ "Document Type": "Invoice", "Transaction Type": "Statement Fee", "Document Date": "2026-07-08", "Document Currency": "SAR",
    Description: "PS-9 : Referral Fee", "VAT Amount (Document Currency)": "1" }),
]
const invResult = noonAdapter.normalize({ formatId: NOON_INVOICES_FORMAT_ID, rows: invRows, account, rules })
const invLines = (row: SourceRow) => invResult.transactions.filter((t) => t.sourceRowNumber === row.rowNumber)
const described = (row: SourceRow) => invLines(row).map((t) => `${meaning(t)?.category ?? t.category}:${t.amount}`).join()

check(
  "referral fee VAT 0.40: +0.40 back into the fee, -0.40 as input VAT (they add to zero)",
  described(invRows[0]) === "MARKETPLACE_FEE:0.40,INPUT_VAT:-0.40",
  described(invRows[0])
)
check(
  "a rebate's negative VAT is reversed the same way",
  described(invRows[1]) === "FULFILLMENT:-0.20,INPUT_VAT:0.20",
  described(invRows[1])
)
check(
  "import VAT recovered by noon: the whole amount leaves fulfilment and becomes input VAT, under review",
  described(invRows[2]) === "FULFILLMENT:1.00,INPUT_VAT:-1.00" && invLines(invRows[2]).every((t) => meaning(t)?.confidence === "MEDIUM"),
  described(invRows[2])
)
check(
  "a credit note on a fee reverses both lines",
  described(invRows[3]) === "ADVERTISING:-1.00,INPUT_VAT:1.00",
  described(invRows[3])
)
check(
  "a fee name BizMind has not seen is kept UNMAPPED, with a warning",
  invLines(invRows[4]).every((t) => t.category === "UNMAPPED") &&
    invResult.issues.some((i) => i.rowNumber === invRows[4].rowNumber && i.severity === "WARNING")
)
check(
  "a sales invoice records its VAT as output VAT owed (-4.76), tied to the order",
  described(invRows[5]) === "OUTPUT_VAT:-4.76" && invLines(invRows[5])[0].orderRef === "NAEITEST1" &&
    invLines(invRows[5])[0].attribution === "ORDER"
)
check("a credit note gives output VAT back (+0.95)", described(invRows[6]) === "OUTPUT_VAT:0.95", described(invRows[6]))
check(
  "a document in another currency is left for that account",
  invLines(invRows[7]).length === 0 && invResult.issues.some((i) => i.rowNumber === invRows[7].rowNumber && i.message.includes("SAR"))
)
check(
  "every invoice line matches its rule by the engine's own key",
  invResult.transactions.filter((t) => t.mappingRuleId).every((t) =>
    classificationMatchKey(t.sourceType, t.sourceSubtype, t.sourceDescription) === meaning(t)?.matchKey)
)

/* -------------------------------------------------------------------------- */
section("4. THE LEDGER WILL ACCEPT THEM, WITHOUT ANY PARTY'S NAME")

const tvBuilt = buildLedgerFilePayload({
  accountId: account.id, accountCurrency: "AED", format: noonTransactionViewFormat,
  file: { name: "tv.csv", type: "csv", sizeBytes: 1, sha256: "a".repeat(64) },
  columns: [...NOON_TV_HEADERS], rows: tvRows, result: tvResult,
})
check("the Transaction View payload is accepted", tvBuilt.ok, tvBuilt.ok ? "" : tvBuilt.problems.join(" | "))

const invBuilt = buildLedgerFilePayload({
  accountId: account.id, accountCurrency: "AED", format: noonInvoicesFormat,
  file: { name: "inv.csv", type: "csv", sizeBytes: 1, sha256: "b".repeat(64) },
  columns: [...NOON_INVOICE_HEADERS], rows: invRows, result: invResult,
})
check("the invoices payload is accepted", invBuilt.ok, invBuilt.ok ? "" : invBuilt.problems.join(" | "))
if (invBuilt.ok) {
  const payload = invBuilt.payload as unknown as { rows: { raw: Record<string, unknown> }[]; stripped_columns: string[] }
  const text = JSON.stringify(payload.rows)
  check(
    "no stored row carries a party's name, tax number or city",
    !text.includes("Invented Buyer") && !text.includes("Invented Seller") && !text.includes("100000000000003") &&
      !text.includes("Invented City") && payload.rows.every((row) => !("Receiver Legal Name" in row.raw))
  )
  check("the dropped columns are recorded by name", payload.stripped_columns.includes("Receiver Legal Name"))
}

/* -------------------------------------------------------------------------- */
section("5. THE RULES ARE CONSISTENT, AND THE MIGRATION SEEDS EXACTLY THEM")

const keys = NOON_RULES.map((r) => `${r.formatId}|${r.matchKey}`)
check(`${NOON_RULES.length} rules, none repeated`, NOON_RULES.length === 61 && new Set(keys).size === keys.length, String(NOON_RULES.length))
check(
  "every import category is valid for its side",
  NOON_RULES.every((r) => (LEDGER_CATEGORIES[r.side] as readonly string[]).includes(r.importCategory))
)
check(
  "fees that include VAT are all expenses",
  NOON_RULES.filter((r) => r.includesVat).every((r) => ["MARKETPLACE_FEE", "FULFILLMENT", "ADVERTISING"].includes(r.category))
)
check(
  "only invoice lines separate VAT, and never also include it",
  NOON_RULES.filter((r) => r.separatesVat).every((r) => r.formatId === NOON_INVOICES_FORMAT_ID && !r.includesVat)
)
check(
  "each VAT-including fee has an invoice line that takes its VAT back into the same category",
  ["MARKETPLACE_FEE", "FULFILLMENT", "ADVERTISING"].every((category) =>
    NOON_RULES.some((r) => r.separatesVat && r.category === category))
)
check(
  "payouts and transfers are cash; they never count in profit",
  NOON_RULES.filter((r) => r.side === "CASH").every((r) => ["PAYOUT", "TRANSFER"].includes(r.category))
)

const sql = readFileSync("supabase/migrations/0034_noon_adapter.sql", "utf8").replace(/\r\n/g, "\n")
const EVIDENCE =
  "Built from the owner's real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). "
const q = (s: string) => `'${s.replace(/'/g, "''")}'`
const missingImport = NOON_RULES.filter((r) => !sql.includes(
  `(${q(r.formatId)}, ${q(r.matchKey)}, ${q(r.side)}, ${q(r.importCategory)}, ${q(r.importSubcategory)}, ${q(r.quantityRule)}, ${q(r.attribution)}, ${q(EVIDENCE + r.note)})`
))
const missingClass = NOON_RULES.filter((r) => !sql.includes(
  `(${q(r.formatId)}, ${q(r.matchKey)}, ${q(r.category)}, ${q(r.subcategory)}, ${q(r.confidence)}, ${r.includesVat}, ${r.separatesVat}, ${q(EVIDENCE + r.note)})`
))
check("migration 0034 seeds every import rule exactly", missingImport.length === 0, missingImport.map((r) => r.matchKey).join(", "))
check("and every classification rule exactly", missingClass.length === 0, missingClass.map((r) => r.matchKey).join(", "))
check(
  "and refuses overlapping exports on upload and on restore",
  sql.includes("This file repeats %s row(s) already counted from the file") && sql.includes("rows are already counted from the file")
)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

process.exit(failed === 0 ? 0 : 1)
