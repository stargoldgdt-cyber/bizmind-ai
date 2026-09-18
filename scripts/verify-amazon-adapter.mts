/**
 * The Amazon Flat File V2 adapter -- offline, on made-up rows.
 *
 * Run with:  npm run test:amazon
 *
 * The rows below are INVENTED. They copy the real report's shape (verified on
 * four Amazon.ae settlements -- see AMAZON.md) but no real order, SKU or amount.
 * The owner's real files are never copied into the repository; they are checked
 * separately by `npm run test:amazon-acceptance -- <folder>`.
 */

import { readFileSync } from "node:fs"

import type { MappingRuleSummary, SourceRow } from "../src/services/marketplaces/contract"
import { isCustomerDataColumn } from "../src/services/marketplaces/customer-data"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import { createAdapterRegistry } from "../src/services/marketplaces/registry"
import {
  AMAZON_V2_FORMAT_ID,
  AMAZON_V2_HEADERS,
  AMAZON_V2_RULES,
  amazonFlatFileV2Adapter,
  amazonFlatFileV2Format,
  negateDecimalText,
  parseAmazonInstant,
} from "../src/services/marketplaces/amazon/flat-file-v2"

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

/* ---- invented fixture ---------------------------------------------------- */

const rules: MappingRuleSummary[] = AMAZON_V2_RULES.map((rule, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  matchKey: rule.matchKey,
  side: rule.side,
  category: rule.category,
  subcategory: rule.subcategory,
  attribution: rule.attribution,
  quantityRule: rule.quantityRule,
  signRule: "AS_REPORTED",
}))

function line(fields: Partial<Record<(typeof AMAZON_V2_HEADERS)[number], string>>): Record<string, string | null> {
  const raw: Record<string, string | null> = {}
  for (const header of AMAZON_V2_HEADERS) raw[header] = fields[header] ?? ""
  return raw
}

const SID = "90000000001"
const order = (itemPrice: Record<string, string>) => ({
  "settlement-id": SID, "transaction-type": "Order", "order-id": "999-0000001-0000001",
  "merchant-order-id": "999-0000001-0000001", "marketplace-name": "Amazon.ae", "fulfillment-id": "AFN",
  "posted-date": "03.07.2026", "posted-date-time": "03.07.2026 10:15:00 UTC", "order-item-code": "11111111111111",
  sku: "FIXTURE-SKU-1", ...itemPrice,
})

const fixture: Record<string, string | null>[] = [
  line({ "settlement-id": SID, "settlement-start-date": "02.07.2026 18:27:57 UTC", "settlement-end-date": "16.07.2026 18:27:57 UTC", "deposit-date": "18.07.2026 18:27:57 UTC", "total-amount": "81.00", currency: "AED" }),
  line(order({ "amount-type": "ItemPrice", "amount-description": "Principal", amount: "100.00", "quantity-purchased": "2" })),
  line(order({ "amount-type": "ItemPrice", "amount-description": "Shipping", amount: "5.00", "quantity-purchased": "2" })),
  line(order({ "amount-type": "ItemFees", "amount-description": "Commission", amount: "-12.00", "quantity-purchased": "2" })),
  line(order({ "amount-type": "ItemFees", "amount-description": "FBAPerUnitFulfillmentFee", amount: "-9.00", "quantity-purchased": "2" })),
  line(order({ "amount-type": "ItemPrice", "amount-description": "COD", amount: "10.00", "quantity-purchased": "2" })),
  line(order({ "amount-type": "ItemFees", "amount-description": "CODFee", amount: "-10.00", "quantity-purchased": "2" })),
  line({ "settlement-id": SID, "transaction-type": "Refund", "order-id": "999-0000001-0000001", "amount-type": "ItemPrice", "amount-description": "Principal", amount: "-50.00", "posted-date": "05.07.2026", "posted-date-time": "05.07.2026 09:00:00 UTC", "adjustment-id": "88888888888", sku: "FIXTURE-SKU-1" }),
  line({ "settlement-id": SID, "transaction-type": "Refund", "order-id": "999-0000001-0000001", "amount-type": "ItemFees", "amount-description": "Commission", amount: "6.00", "posted-date": "05.07.2026", "posted-date-time": "05.07.2026 09:00:00 UTC", sku: "FIXTURE-SKU-1" }),
  line({ "settlement-id": SID, "transaction-type": "ServiceFee", "amount-type": "Cost of Advertising", "amount-description": "TransactionTotalAmount", amount: "-20.00", "posted-date": "06.07.2026", "posted-date-time": "06.07.2026 00:00:00 UTC" }),
  line({ "settlement-id": SID, "transaction-type": "AmazonFees", "marketplace-name": "Amazon.ae", "amount-type": "Premium Services Fee", "amount-description": "Base fee", amount: "-20.00", "posted-date": "02.07.2026", "posted-date-time": "02.07.2026 12:00:00 UTC" }),
  line({ "settlement-id": SID, "transaction-type": "AmazonFees", "marketplace-name": "Amazon.ae", "amount-type": "Premium Services Fee", "amount-description": "Tax on fee", amount: "-1.00", "posted-date": "02.07.2026", "posted-date-time": "02.07.2026 12:00:00 UTC" }),
  line({ "settlement-id": SID, "transaction-type": "FBAFees", "marketplace-name": "Amazon.ae", "amount-type": "FBA Inventory Storage Fee", "amount-description": "Base fee", amount: "0.00", "fulfillment-id": "AFN", "posted-date": "07.07.2026", "posted-date-time": "07.07.2026 00:00:00 UTC" }),
  line({ "settlement-id": SID, "transaction-type": "Order", "order-id": "999-0000002-0000002", "amount-type": "ItemFees", "amount-description": "BrandNewFeeCode", amount: "-2.00", "posted-date": "08.07.2026", "posted-date-time": "08.07.2026 00:00:00 UTC", sku: "FIXTURE-SKU-2" }),
]

const rows: SourceRow[] = fixture.map((raw, index) => ({ rowNumber: index + 2, raw }))
const account = { id: "22222222-2222-4222-8222-222222222222", marketplaceCode: "AMAZON", currency: "AED" }
const result = amazonFlatFileV2Adapter.normalize({ formatId: AMAZON_V2_FORMAT_ID, rows, account, rules })
const at = (rowNumber: number) => result.transactions.find((t) => t.sourceRowNumber === rowNumber)

/* -------------------------------------------------------------------------- */
section("1. RECOGNISING THE FILE")

const detect = (headers: string[]) => amazonFlatFileV2Adapter.detect({ fileName: "x.txt", headers, rows: [] })

check("the 24 Flat File V2 headers are recognised exactly", detect([...AMAZON_V2_HEADERS]).kind === "match")
check("in any order", detect([...AMAZON_V2_HEADERS].reverse()).kind === "match")
check(
  "extra columns make the match only 'likely'",
  (() => { const r = detect([...AMAZON_V2_HEADERS, "new-column"]); return r.kind === "match" && r.confidence === "likely" })()
)
const dateRange = detect(["date/time", "settlement id", "type", "order id", "sku", "description", "quantity", "product sales", "amazon fees", "total"])
check(
  "THE DATE RANGE TRANSACTION REPORT IS REFUSED, and told what to download instead",
  dateRange.kind === "reject" && dateRange.message.includes("Flat File V2"),
  JSON.stringify(dateRange)
)
check(
  "the deprecated flat file V1 is refused",
  detect(["settlement-id", "price-type", "item-related-fee-type", "amount"]).kind === "reject"
)
check(
  "the settlement summary export is refused",
  detect(["Sales", "Total Sales", "Total Expense", "Payment", "product Wholesale Price"]).kind === "reject"
)
check("a file with one header missing is not guessed at", detect(AMAZON_V2_HEADERS.slice(1)).kind === "unknown")
check("an unrelated file is unknown", detect(["Order Nr", "Partner SKUs", "Transaction Type"]).kind === "unknown")

check(
  "no allowed column is customer data",
  amazonFlatFileV2Format.allowedColumns.every((column) => !isCustomerDataColumn(column))
)
check(
  "the registry accepts the adapter",
  (() => { const r = createAdapterRegistry(); r.register(amazonFlatFileV2Adapter); return r.get("AMAZON") !== null })()
)

/* -------------------------------------------------------------------------- */
section("2. DATES, SIGNS AND AMOUNTS")

check("Amazon.ae's dotted date is read as UTC", parseAmazonInstant("02.07.2026 18:27:57 UTC") === "2026-07-02T18:27:57Z")
check("the documented ISO form is read too", parseAmazonInstant("2026-07-02 18:27:57 UTC") === "2026-07-02T18:27:57Z")
check("an impossible date is refused, not rolled over", parseAmazonInstant("31.02.2026 10:00:00 UTC") === null)
check("a date without a time is not guessed at", parseAmazonInstant("02.07.2026") === null)
check("a US-style date is not guessed at", parseAmazonInstant("07/02/2026 18:27:57 UTC") === null)
check(
  "a sign change is a text operation",
  negateDecimalText("12.50") === "-12.50" && negateDecimalText("-3.00") === "3.00" && negateDecimalText("0.00") === "0.00"
)

/* -------------------------------------------------------------------------- */
section("3. EVERY ROW LANDS SOMEWHERE")

check("one settlement from the header row", result.settlements.length === 1)
const settlement = result.settlements[0]
check(
  "with its total, currency, period and deposit date",
  settlement?.externalSettlementId === SID && settlement.reportedTotal === "81.00" && settlement.currency === "AED" &&
    settlement.periodStart === "2026-07-02T18:27:57Z" && settlement.reportedDepositDate === "2026-07-18T18:27:57Z",
  JSON.stringify(settlement)
)
check(
  "AND THE PAYOUT AMAZON REPORTS: the total on the deposit date (owner decision)",
  result.payouts.length === 1 && result.payouts[0].amount === "81.00" && result.payouts[0].paidAt === "2026-07-18T18:27:57Z" &&
    result.payouts[0].settlementRef === SID && result.payouts[0].sourceRowNumber === 2,
  JSON.stringify(result.payouts)
)
check("every amount row becomes a transaction", result.transactions.length === fixture.length - 1)
check(
  "THE HEADER'S CURRENCY IS CARRIED TO LINES WHOSE OWN CURRENCY IS BLANK",
  result.transactions.every((t) => t.currency === "AED" && t.settlementRef === SID)
)

/* -------------------------------------------------------------------------- */
section("4. CLASSIFICATION FOLLOWS THE APPROVED RULES")

const principal = at(3)
check(
  "Principal is revenue, with the units reported",
  principal?.category === "REVENUE" && principal.subcategory === "principal" && principal.quantity === "2" && principal.quantityBasis === "REPORTED"
)
check("Shipping is revenue, with no units", at(4)?.category === "REVENUE" && at(4)?.quantity === null)
check("Commission is a referral marketplace fee", at(5)?.category === "MARKETPLACE_FEE" && at(5)?.subcategory === "referral")
check("the FBA fee is fulfilment", at(6)?.category === "FULFILMENT" && at(6)?.subcategory === "fba_per_unit")
check("THE COD CHARGE IS OTHER INCOME, NOT SALES (owner decision)", at(7)?.category === "OTHER_INCOME" && at(7)?.subcategory === "cod_charge")
check("the COD fee is a marketplace fee", at(8)?.category === "MARKETPLACE_FEE" && at(8)?.subcategory === "cod")
const refund = at(9)
check(
  "A REFUND PRINCIPAL LINE COUNTS AS ONE REFUNDED UNIT, marked as derived",
  refund?.category === "REFUND" && refund.quantity === "1" && refund.quantityBasis === "DERIVED_LINE_COUNT"
)
check("refunded commission nets into the same referral fee", at(10)?.category === "MARKETPLACE_FEE" && at(10)?.subcategory === "referral" && at(10)?.amount === "6.00")
check(
  "advertising has no SKU and stays at marketplace level",
  at(11)?.category === "ADVERTISING" && at(11)?.attribution === "MARKETPLACE" && at(11)?.orderRef === null
)
check(
  "THE SP 360 PREMIUM SERVICES FEE IS A MARKETPLACE FEE, not advertising (owner decision)",
  at(12)?.category === "MARKETPLACE_FEE" && at(12)?.subcategory === "premium_services" && at(12)?.attribution === "MARKETPLACE"
)
check(
  "ITS 5% TAX IS A SEPARATE VAT LINE (owner decision)",
  at(13)?.side === "TAX" && at(13)?.category === "FEE_VAT"
)
check("a reported 0.00 storage fee is kept as a recorded zero", at(14)?.category === "FULFILMENT" && at(14)?.amount === "0.00")

const unknown = at(15)
check(
  "AN UNKNOWN CODE IS KEPT AS UNMAPPED, never guessed",
  unknown?.category === "UNMAPPED" && unknown.side === null && unknown.mappingRuleId === null && unknown.amount === "-2.00"
)
check(
  "and reported as a row issue naming the code",
  result.issues.some((i) => i.rowNumber === 15 && i.severity === "WARNING" && i.message.includes("BrandNewFeeCode"))
)
check("amounts are the source's exact text", principal?.amount === "100.00" && at(5)?.amount === "-12.00")
check(
  "posted dates are UTC instants",
  principal?.postedAt === "2026-07-03T10:15:00Z" && refund?.postedAt === "2026-07-05T09:00:00Z"
)

/* -------------------------------------------------------------------------- */
section("5. WHAT IT REFUSES TO GUESS")

const bad = amazonFlatFileV2Adapter.normalize({
  formatId: AMAZON_V2_FORMAT_ID,
  account,
  rules,
  rows: [
    { rowNumber: 2, raw: fixture[0] },
    { rowNumber: 3, raw: { ...fixture[1], amount: "1.234,56" } },
    { rowNumber: 4, raw: { ...fixture[2], "posted-date-time": "03.07.2026" } },
    { rowNumber: 5, raw: { ...fixture[3], "settlement-id": "OTHER-SETTLEMENT" } },
    { rowNumber: 6, raw: line({}) },
  ],
})
check(
  "a comma-decimal amount is an ERROR row issue, not reinterpreted",
  bad.issues.some((i) => i.rowNumber === 3 && i.severity === "ERROR" && i.field === "amount") &&
    !bad.transactions.some((t) => t.sourceRowNumber === 3)
)
check(
  "a posted date without a time is an ERROR row issue",
  bad.issues.some((i) => i.rowNumber === 4 && i.severity === "ERROR" && i.field === "posted-date-time")
)
check(
  "a line whose settlement has no header in the file is refused: its currency cannot be known",
  bad.issues.some((i) => i.rowNumber === 5 && i.severity === "ERROR" && i.field === "settlement-id")
)
check("an empty line is reported, not dropped", bad.issues.some((i) => i.rowNumber === 6))

const noCurrency = amazonFlatFileV2Adapter.normalize({
  formatId: AMAZON_V2_FORMAT_ID, account, rules,
  rows: [{ rowNumber: 2, raw: { ...fixture[0], currency: "" } }, { rowNumber: 3, raw: fixture[1] }],
})
check(
  "A SETTLEMENT WITH NO CURRENCY IS REFUSED, AND SO ARE ITS LINES -- no currency is assumed",
  noCurrency.settlements.length === 0 && noCurrency.transactions.length === 0 &&
    noCurrency.issues.some((i) => i.field === "currency") && noCurrency.issues.some((i) => i.rowNumber === 3)
)

/* -------------------------------------------------------------------------- */
section("6. THE RESULT IS A FILE THE LEDGER WILL ACCEPT")

const built = buildLedgerFilePayload({
  accountId: account.id,
  accountCurrency: "AED",
  format: amazonFlatFileV2Format,
  file: { name: "90000000001.txt", type: "txt", sizeBytes: 4096, sha256: "b".repeat(64) },
  columns: [...AMAZON_V2_HEADERS],
  rows,
  result,
})
check("the payload builder accepts every row", built.ok, built.ok ? "" : built.problems.join(" | "))
check(
  "nothing is stripped from a genuine report",
  built.ok && built.payload.stripped_columns.length === 0
)
const sarAccount = buildLedgerFilePayload({
  accountId: account.id, accountCurrency: "SAR", format: amazonFlatFileV2Format,
  file: { name: "x.txt", type: "txt", sizeBytes: 1, sha256: "c".repeat(64) }, columns: [...AMAZON_V2_HEADERS], rows, result,
})
check(
  "AN AED SETTLEMENT UPLOADED TO A SAR ACCOUNT IS REFUSED BEFORE ANYTHING IS SENT",
  !sarAccount.ok && sarAccount.problems.some((p) => p.includes("does not match the account currency"))
)

/* -------------------------------------------------------------------------- */
section("7. THE RULES IN CODE ARE THE RULES IN THE DATABASE")

let migration = ""
try {
  // 0031 seeded the 21 approved rules; 0044 added the one-line SP 360 fee.
  migration =
    readFileSync("supabase/migrations/0031_amazon_flat_file_v2.sql", "utf8") +
    readFileSync("supabase/migrations/0044_amazon_paid_services_fee.sql", "utf8")
} catch {
  migration = ""
}
check("migration 0031 exists", migration.length > 0)
check("the migrations seed exactly the 22 approved rules", AMAZON_V2_RULES.length === 22)
const missingInSql = AMAZON_V2_RULES.filter(
  (rule) => !migration.includes(`('${rule.matchKey}',`) || !migration.includes(`'${rule.category}', '${rule.subcategory}', '${rule.quantityRule}', '${rule.attribution}'`)
)
check(
  "every rule is in the migration with the same classification",
  missingInSql.length === 0,
  missingInSql.map((rule) => rule.matchKey).join(", ")
)
check(
  "and every rule's side matches",
  AMAZON_V2_RULES.every((rule) => migration.includes(`('${rule.matchKey}', '{"transaction-type"`) && migration.includes(`'${rule.side}', '${rule.category}', '${rule.subcategory}'`))
)
check("each match key is unique", new Set(AMAZON_V2_RULES.map((rule) => rule.matchKey)).size === AMAZON_V2_RULES.length)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
