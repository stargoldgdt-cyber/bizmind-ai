/**
 * Canonical mapping: the rules that must hold without a database.
 *
 * Run with:  npm run test:mapping
 *
 * The subject of this suite is a refusal. A name-matching rule that quietly
 * grew the confidence to confirm things would be almost impossible to notice
 * from the outside: the numbers would still look like numbers. So the tests
 * are mostly about what the suggestion engine will NOT do.
 */

import { readFileSync } from "node:fs"

import {
  CANONICAL_METRICS,
  computedMetrics,
  getCanonicalMetric,
  isMappableMetric,
  mappableMetrics,
} from "../src/services/metrics/canonical"
import {
  canConfirmMappingTo,
  columnSignature,
  normaliseLabel,
  suggestMetricForColumn,
  suggestMetricsForColumns,
} from "../src/services/ingestion/canonical-mapping"
import { METRICS } from "../src/services/analytics/types"
import {
  AMAZON_SETTLEMENT,
  confirmedFields,
  fieldsAwaitingConfirmation,
  hasDocumentedConfirmation,
} from "../src/services/ingestion/source-fields"

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

/* -------------------------------------------------------------------------- */
section("1. THE VOCABULARY")

const required = [
  "revenue",
  "cogs",
  "gross_profit",
  "gross_margin",
  "marketplace_fees",
  "advertising_cost",
  "shipping_expense",
  "storage_cost",
  "refunds",
  "promotional_rebates",
  "other_expenses",
  "total_expense",
  "payment_received",
  "orders",
  "units",
  "aov",
  "cost_coverage",
]

for (const key of required) {
  check(`${key} is in the vocabulary`, getCanonicalMetric(key) !== undefined)
}

check(
  "every metric has a definition an owner could check",
  Object.values(CANONICAL_METRICS).every((m) => m.definition.length > 30)
)
check(
  "every metric states whether rising is good",
  Object.values(CANONICAL_METRICS).every((m) => typeof m.higherIsBetter === "boolean")
)
check(
  "every key matches its own entry, so a lookup cannot return a different metric",
  Object.entries(CANONICAL_METRICS).every(([key, m]) => key === m.key)
)

/* -------------------------------------------------------------------------- */
section("2. ONE DEFINITION, NOT TWO")

// The dashboard registry must be a VIEW of the canonical one. If it ever
// becomes a second copy, a metric can come to mean two things at once and
// nobody finds out until the two disagree in front of a customer.
const analyticsEntries = Object.values(METRICS)

check(
  "the analytics registry is derived, not written out again",
  analyticsEntries.length > 0 &&
    analyticsEntries.every((m) => getCanonicalMetric(m.canonicalKey) !== undefined)
)

check(
  "every published definition is character-for-character the canonical one",
  analyticsEntries.every(
    (m) => m.definition === getCanonicalMetric(m.canonicalKey)?.definition
  )
)

check(
  "cost of goods keeps its warning about missing costs",
  METRICS.cogs.caveat !== undefined && METRICS.cogs.caveat.includes("cost coverage")
)

check(
  "the dashboard's 'fees' is the canonical marketplace_fees",
  METRICS.fees.canonicalKey === "marketplace_fees"
)

// METRICS is now BUILT rather than written out, so a metric could silently
// vanish from it -- and the dashboard reads `METRICS.<key>.label` directly,
// which would throw at request time, not build time. Read the page and check
// every key it actually uses.
const dashboardSource = readFileSync("src/app/(app)/dashboard/page.tsx", "utf8")
const usedKeys = [...dashboardSource.matchAll(/METRICS\.([a-z_]+)\./g)].map((m) => m[1])

check("the dashboard references metrics at all", usedKeys.length >= 10, String(usedKeys.length))

const missing = [...new Set(usedKeys)].filter((key) => METRICS[key] === undefined)
check(
  "every metric the dashboard uses still exists in the built registry",
  missing.length === 0,
  missing.join(", ")
)

check(
  "and every one of them has a label to show",
  [...new Set(usedKeys)].every((key) => (METRICS[key]?.label.length ?? 0) > 0)
)

/* -------------------------------------------------------------------------- */
section("3. A SOURCE CANNOT SUPPLY A CONCLUSION")

for (const key of ["gross_profit", "gross_margin", "net_profit", "net_margin", "aov"]) {
  check(`${key} cannot be mapped from a source column`, !isMappableMetric(key))
  check(`${key} is refused by the confirmation guard`, !canConfirmMappingTo(key))
}

check(
  "coverage figures are computed too -- they measure our own data",
  !isMappableMetric("cost_coverage") && !isMappableMetric("fee_coverage")
)

check("cost of goods CAN be supplied by a source", isMappableMetric("cogs"))
check("revenue CAN be supplied by a source", isMappableMetric("revenue"))

check(
  "a metric that does not exist is refused, not treated as new",
  !canConfirmMappingTo("profit_i_just_made_up") && !canConfirmMappingTo("")
)

check(
  "every metric is either sourced or computed, never neither",
  mappableMetrics().length + computedMetrics().length ===
    Object.keys(CANONICAL_METRICS).length
)

/* -------------------------------------------------------------------------- */
section("4. SUGGESTIONS ARE NEVER CONFIRMATIONS")

// The heart of it. Every one of these names points at cost of goods. Not one
// of them may arrive confirmed.
const costNames = [
  "COGS",
  "Cost of Goods Sold",
  "Product Cost",
  "Product Wholesale Price",
  "Wholesale Cost",
  "Cost Price",
  "Unit Cost",
  "Item Cost",
  "Landed Cost",
  "Purchase Cost",
  "Wholesale Price",
]

for (const name of costNames) {
  const suggestion = suggestMetricForColumn(name)
  check(`"${name}" is recognised as a candidate for cost of goods`,
    suggestion?.candidateMetric === "cogs",
    String(suggestion?.candidateMetric)
  )
  check(`"${name}" arrives PENDING_CONFIRMATION, never confirmed`,
    suggestion?.status === "PENDING_CONFIRMATION",
    String(suggestion?.status)
  )
}

// The type system already forbids this -- `suggestMetricForColumn` returns a
// status narrowed to SUGGESTED | PENDING_CONFIRMATION, so writing the
// comparison directly is a compile error. The runtime check stays anyway:
// types are erased, and the guarantee has to survive a refactor that widens
// the return type without anyone noticing.
check(
  "there is no input at all that makes the engine confirm something",
  [...costNames, "Revenue", "Amazon Fees", "", "   ", "Total Sales"]
    .map(suggestMetricForColumn)
    .every((s) => s === null || (s.status as string) !== "CONFIRMED")
)

/* -------------------------------------------------------------------------- */
section("5. THE FALSE FRIENDS ARE NAMED")

// A name that matches AND routinely means something else is the dangerous
// case. Matching it confidently would be worse than not matching it at all.
const falseFriends = ["Product Cost", "Purchase Cost", "Wholesale Price", "Product Wholesale Price"]

for (const name of falseFriends) {
  const suggestion = suggestMetricForColumn(name)
  check(`"${name}" carries a warning about what else it can mean`,
    (suggestion?.ambiguityWarning?.length ?? 0) > 20,
    suggestion?.ambiguityWarning
  )
  check(`"${name}" is not treated as a high-confidence name`,
    suggestion?.confidence !== "high",
    suggestion?.confidence
  )
}

check(
  '"Purchase Cost" warns that it is usually restocking, not what sold',
  suggestMetricForColumn("Purchase Cost")?.ambiguityWarning?.includes("restocking") === true
)

check(
  '"Wholesale Price" warns it may be a price CHARGED, not paid',
  suggestMetricForColumn("Wholesale Price")?.ambiguityWarning?.includes("CHARGE") === true
)

check(
  '"COGS" is a high-confidence name -- it has one meaning',
  suggestMetricForColumn("COGS")?.confidence === "high"
)

check(
  '"Net Sales" warns about double-counting refunds',
  suggestMetricForColumn("Net Sales")?.ambiguityWarning?.includes("twice") === true
)

/* -------------------------------------------------------------------------- */
section("6. MATCHING IS FORGIVING ABOUT FORM, STRICT ABOUT MEANING")

check("casing does not matter", suggestMetricForColumn("cost of goods sold")?.candidateMetric === "cogs")
check("underscores do not matter", suggestMetricForColumn("unit_cost")?.candidateMetric === "cogs")
check("punctuation does not matter", suggestMetricForColumn("Cost-of-Goods")?.candidateMetric === "cogs")

const advertising = ["Advertising", "Ad Spend", "Marketing Cost", "PPC Cost", "Cost of Advertising"]
for (const name of advertising) {
  check(`"${name}" points at advertising`,
    suggestMetricForColumn(name)?.candidateMetric === "advertising_cost",
    String(suggestMetricForColumn(name)?.candidateMetric)
  )
}

const fees = ["Amazon Fees", "Marketplace Fees", "Selling Fees", "Platform Fees", "Referral Fees"]
for (const name of fees) {
  check(`"${name}" points at channel fees`,
    suggestMetricForColumn(name)?.candidateMetric === "marketplace_fees",
    String(suggestMetricForColumn(name)?.candidateMetric)
  )
}

const revenues = ["Sales", "Revenue", "Total Sales", "Net Sales", "Gross Sales"]
for (const name of revenues) {
  check(`"${name}" points at revenue`,
    suggestMetricForColumn(name)?.candidateMetric === "revenue",
    String(suggestMetricForColumn(name)?.candidateMetric)
  )
}

check(
  "a heading with extra words matches loosely and says so",
  suggestMetricForColumn("FBA Storage Fee (AED)")?.candidateMetric === "storage_cost" &&
    suggestMetricForColumn("FBA Storage Fee (AED)")?.confidence === "low"
)

check(
  "an unrecognised heading returns nothing rather than a poor guess",
  suggestMetricForColumn("Warehouse Bay") === null &&
    suggestMetricForColumn("Customer Notes") === null
)

check(
  "a blank heading is not matched to anything",
  suggestMetricForColumn("") === null && suggestMetricForColumn("   ") === null
)

check(
  "a whole file is suggested in order, skipping what it does not know",
  suggestMetricsForColumns(["Order ID", "Sales", "Amazon Fees", "Notes"]).map(
    (s) => s.candidateMetric
  ).join(",") === "revenue,marketplace_fees"
)

/* -------------------------------------------------------------------------- */
section("7. RECOGNISING THE SAME FILE AGAIN")

const january = ["Sales", "Amazon fees", "Payment"]
const february = ["Payment", "Sales", "Amazon Fees"]
const march = ["Sales", "Amazon fees", "Payment", "Storage Fee"]

check(
  "column order and casing do not change the signature",
  columnSignature(january) === columnSignature(february)
)
check(
  "A NEW COLUMN CHANGES THE SIGNATURE, so it gets asked about",
  columnSignature(january) !== columnSignature(march)
)
check(
  "a repeated column does not change the signature",
  columnSignature(["Sales", "Sales", "Payment"]) === columnSignature(["Payment", "Sales"])
)
check("an empty heading is ignored in the signature",
  columnSignature(["Sales", "", "Payment"]) === columnSignature(["Sales", "Payment"])
)
check("normalisation is stable", normaliseLabel("  Amazon   FEES  ") === "amazon fees")

/* -------------------------------------------------------------------------- */
section("8. THE REAL AMAZON FILE")

const wholesale = AMAZON_SETTLEMENT.fields.find((f) => f.key === "product_wholesale_price")
const profitLoss = AMAZON_SETTLEMENT.fields.find((f) => f.key === "profit_loss")

check("the wholesale column is on record", wholesale !== undefined)
check(
  "it is CONFIRMED as cost of goods -- the owner answered the question",
  wholesale?.status === "CONFIRMED" && wholesale?.mapsTo === "cogs"
)
check("the confirmation names who made it", (wholesale?.confirmedBy?.length ?? 0) > 0)
check(
  "and records that it is about THIS business, not about the phrase",
  wholesale?.note.includes("THIS BUSINESS") === true
)
check(
  "the reasoning that made it undecidable from the file is preserved",
  wholesale?.note.includes("OUTSIDE the settlement") === true
)

check("Profit/Loss is still on record", profitLoss !== undefined)
check("Profit/Loss is NOT confirmed", profitLoss?.status !== "CONFIRMED")
check("Profit/Loss maps to nothing", profitLoss?.mapsTo === null)
check(
  "and it could not be mapped to net profit even by request",
  !canConfirmMappingTo("net_profit")
)

check(
  "the settlement identity is still recorded as a reconciliation",
  AMAZON_SETTLEMENT.reconciliations.some(
    (r) => r.formula === "total_sales - total_expense = payment"
  )
)

check(
  "every candidate in the profile names a real, sourceable metric",
  AMAZON_SETTLEMENT.fields
    .filter((f) => f.candidateMetric)
    .every((f) => isMappableMetric(f.candidateMetric ?? ""))
)

check(
  "no field claims a mapping without a confirmation",
  AMAZON_SETTLEMENT.fields.every((f) => f.mapsTo === null || f.status === "CONFIRMED")
)

check(
  "the confirmed list is exactly the wholesale column",
  confirmedFields(AMAZON_SETTLEMENT).length === 1 &&
    confirmedFields(AMAZON_SETTLEMENT)[0].key === "product_wholesale_price"
)

check(
  "everything else is still awaiting a decision",
  fieldsAwaitingConfirmation(AMAZON_SETTLEMENT).length ===
    AMAZON_SETTLEMENT.fields.length - 1
)

check(
  "the documented-confirmation helper agrees",
  hasDocumentedConfirmation(AMAZON_SETTLEMENT.fields[0]) === false
)

/* -------------------------------------------------------------------------- */
section("9. NO ARITHMETIC LIVES HERE")

// This module decides meaning. If it ever starts adding figures up, the rule
// that keeps every financial calculation in SQL has been broken in the one
// place nobody would think to look.
const source = readFileSync("src/services/ingestion/canonical-mapping.ts", "utf8")

check(
  "the mapping module does no money arithmetic",
  !/Number\s*\(/.test(source) && !/parseFloat/.test(source)
)
check(
  "and imports nothing that computes figures",
  !source.includes("@/services/analytics")
)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
