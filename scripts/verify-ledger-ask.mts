/**
 * Ask BizMind on the marketplace ledger, offline: the intent and guard suite
 * (GCC Phase 9).
 *
 * Run with:  npm run test:ledger-ask   (part of npm run verify)
 *
 * A fake model stands in for OpenAI, so every guard decision is exercised
 * without a network call. Proves:
 *   - each question sees only the figures it needs, formatted as the screens are
 *   - a figure that is not final is written NOT FINAL, with its reasons, and no
 *     final number is invented for it
 *   - an expected payout is written as expected, never received; the bank is not connected
 *   - a reply with an invented number, a "received" claim, or a "final" claim
 *     about a not-final figure is discarded, and the figures are still returned
 *   - the browser can send only a question key and a month
 */

import { readFileSync } from "node:fs"

import type { Database } from "../src/types/database"

// A fake key, so the client tries the (fake) network.
process.env.OPENAI_API_KEY = "sk-test-0000000000000000000000000000"
let nextReply = ""
type SentRequest = { messages: { role: string; content: string }[] }
const sent: SentRequest[] = []
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body ?? "{}")) as SentRequest)
  return new Response(JSON.stringify({ model: "fake-model", choices: [{ message: { content: nextReply } }] }), { status: 200 })
}) as typeof fetch

const { answerLedgerQuestion } = await import("../src/services/ai/analyst")
const { buildLedgerFactText, isLedgerQuestion, LEDGER_QUESTIONS, QUESTION_NEEDS } = await import("../src/services/ai/ledger-facts")
const { claimsFinality, claimsMoneyReceived } = await import("../src/services/ai/guard")

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

type Fn = Database["public"]["Functions"]
type Summary = Fn["pnl_summary"]["Returns"][number]

const base: Summary = {
  marketplace_account_id: null as unknown as string, account_label: "All AED accounts", marketplace_code: "MIXED",
  currency: "AED", period_from: "2026-07-01T00:00:00Z", period_to: "2026-08-01T00:00:00Z", gross_sales: "214520.1900",
  sales_refunds: "-5242.1300", seller_discounts: "-281.7700", net_sales: "208996.2900", other_income: "12292.6200",
  marketplace_fees: "-31348.6300", fulfillment: "-31485.2800", advertising: "-9656.8900", other_marketplace_costs: "0.0000",
  non_recoverable_vat: "0.0000", contribution: null, contribution_status: "INCOMPLETE",
  contribution_before_open_items: "148993.3800", figures_status: "FINAL", input_vat_recoverable: "0.0000",
  input_vat_unresolved: "-2367.5700", output_vat: "-7051.2800", input_vat_treatment: "MIXED", lines: 5342,
  unknown_lines: 0, unknown_amount: "0.0000", review_lines: 132, review_amount: "-1.0000", conditional_lines: 2,
  row_errors: 0, incomplete_reasons: ["VAT_TREATMENT_UNKNOWN"], accounts: 2, units_sold: "1700.0000",
  cogs: "0.0000", units_without_product: "1700.0000", units_without_cost: "0.0000", sales_without_cost: "200000.0000",
  gross_profit: null, gross_profit_status: "INCOMPLETE", gross_profit_before_open_items: "148993.3800",
  gross_profit_reasons: ["VAT_TREATMENT_UNKNOWN", "SKU_NOT_MAPPED"],
  orders: 1200, average_order_value: "174.1600", profit_per_order: null, gross_margin_pct: null,
}
const sar: Summary = {
  ...base, currency: "SAR", account_label: "All SAR accounts", accounts: 1, gross_sales: "500.0000", net_sales: "500.0000",
  contribution: "400.0000", contribution_status: "FINAL", incomplete_reasons: [], gross_profit: "150.0000",
  gross_profit_status: "FINAL", gross_profit_reasons: [], cogs: "-250.0000",
}
const net = {
  currency: "AED", accounts: 2, contribution: null, cogs: "0.0000", gross_profit: null, gross_profit_status: "INCOMPLETE",
  gross_profit_before_open_items: "148993.3800", expense_lines: 4, operating_expenses: "-7000.0000",
  external_advertising: "-500.0000", not_in_profit: "-20000.0000", unclassified_expense_lines: 1,
  unclassified_expense_amount: "-120.0000", net_profit: null, net_profit_status: "INCOMPLETE",
  net_profit_before_open_items: "141493.3800", net_profit_reasons: ["VAT_TREATMENT_UNKNOWN", "SKU_NOT_MAPPED", "EXPENSES_UNCLASSIFIED"],
} satisfies Fn["pnl_net_profit"]["Returns"][number]
const payout = {
  payout_key: "k1", source: "SETTLEMENT_REPORT", marketplace_account_id: "a", account_label: "Amazon.ae",
  marketplace_code: "AMAZON", currency: "AED", reference: "INVENTED", source_file_id: null, file_name: null,
  period_start: null, period_end: null, expected_date: "2026-07-18T08:00:00Z", expected_amount: "24323.3800",
  settlement_lines_total: "24323.3800", settlement_lines: 300, marketplace_status: "ADDS_UP",
  bank_receipt_status: "NOT_CONNECTED", bank_receipt_amount: null, bank_receipt_date: null, difference: "0.0000",
} satisfies Fn["expected_payouts"]["Returns"][number]
const product = (name: string, gross: string | null, kind: "PRODUCT" | "UNMAPPED_SKU" = "PRODUCT") => ({
  currency: "AED", row_kind: kind, product_id: kind === "PRODUCT" ? name : null, product_name: kind === "PRODUCT" ? name : null,
  product_category: null, raw_sku: kind === "PRODUCT" ? null : name, marketplace_code: kind === "PRODUCT" ? null : "NOON",
  lines: 3, units_sold: "2.0000", net_sales: "100.0000", other_income: "0.0000", costs: "-10.0000", contribution: "90.0000",
  cogs: gross === null ? null : "-40.0000", gross_profit: gross, gross_margin_percent: gross === null ? null : "50.0",
  cogs_status: gross === null ? (kind === "PRODUCT" ? "NO_COST" : "NO_PRODUCT") : "COSTED",
} satisfies Fn["pnl_by_product"]["Returns"][number])

const input = {
  businessName: "Invented Trading",
  monthLabel: "July 2026",
  perCurrency: [base, sar],
  perAccount: [{ ...base, account_label: "Amazon.ae", marketplace_code: "AMAZON", accounts: 1 }],
  net: [net],
  products: [product("Bottle", "50.0000"), product("Mug", "-5.0000"), product("Cup", "12.5000"), product("Lamp", null),
    product("SKU-X", null, "UNMAPPED_SKU")],
  payouts: [payout, { ...payout, payout_key: "k2", expected_amount: null, marketplace_status: "NO_TOTAL" as const }],
  quality: [],
  expenses: [],
}

/* -------------------------------------------------------------------------- */
section("1. THE QUESTIONS AND WHAT THEY SEE")

check("six fixed questions", Object.keys(LEDGER_QUESTIONS).length === 6)
check("an invented question key is refused", !isLedgerQuestion("forecast-next-year") && !isLedgerQuestion("__proto__") && isLedgerQuestion("payouts"))
check("each question names the readers it needs", Object.keys(LEDGER_QUESTIONS).every((q) => (QUESTION_NEEDS as Record<string, unknown[]>)[q]?.length > 0))

const summary = buildLedgerFactText("month-summary", input)
check("a not-final contribution is written NOT FINAL with its reason",
  summary.includes("- Contribution: NOT FINAL -- the VAT setting for marketplace fees has not been chosen; so far, NOT FINAL: AED 148,993.38"),
  summary)
check("a final one is written as final", summary.includes("- Contribution: SAR 400.00 (final)"))
check("net profit carries every reason it is not final",
  summary.includes("- Net profit: NOT FINAL -- the VAT setting for marketplace fees has not been chosen; some marketplace SKUs are not matched to a product; some expense categories have not been placed"))
check("currencies are kept in separate sections", summary.includes("## All marketplace accounts in AED") &&
  summary.includes("## All marketplace accounts in SAR") && summary.includes("never added together"))
check("the month summary does not carry payouts or products", !summary.includes("Expected") && !summary.includes("Bottle"))

const payouts = buildLedgerFactText("payouts", input)
check("payouts are written as expected, NOT received", payouts.includes("expected, NOT received") &&
  payouts.includes("- Amazon.ae: AED 24,323.38 expected on 2026-07-18; the settlement adds up"))
check("a payout with no total gets no invented amount", payouts.includes("no amount in the report expected on 2026-07-18; the report states no total"))
check("the bank reads not connected", payouts.includes("Actual bank receipts: not connected"))

const products = buildLedgerFactText("products", input)
const bestAt = products.indexOf("## Highest")
check("the best product is first by exact comparison, the worst product first in its list",
  products.indexOf("Bottle") > bestAt && products.indexOf("Bottle") < products.indexOf("Cup") &&
    products.slice(products.indexOf("## Lowest")).indexOf("Mug") < products.slice(products.indexOf("## Lowest")).indexOf("Cup"),
  products)
check("uncosted and unmatched products are counted, not ranked",
  products.includes("SKUs not matched to a product: 1") && products.includes("without a cost for every sale: 1") && !products.includes("Lamp"))

/* -------------------------------------------------------------------------- */
section("2. THE GUARDS")

for (const bad of [
  "You received AED 24,323.38 from Amazon.",
  "Your payout of AED 24,323.38 has been received.",
  "The payout was deposited into your account.",
  "AED 24,323.38 reached your bank on 18 July.",
]) {
  check(`received claim caught: "${bad}"`, claimsMoneyReceived(bad))
}
for (const fine of [
  "Amazon expects to pay AED 24,323.38 on 18 July; it has not been received yet as far as BizMind can tell.",
  "No bank account is connected, so BizMind cannot confirm the money arrived.",
]) {
  check(`honest wording allowed: "${fine}"`, !claimsMoneyReceived(fine))
}
check("a final claim is caught", claimsFinality("Your final profit is strong.") && claimsFinality("Net profit is confirmed."))
check("saying it is not final is allowed", !claimsFinality("Net profit is not final yet."))

/* -------------------------------------------------------------------------- */
section("3. THE WHOLE PATH, WITH A FAKE MODEL")

nextReply = "Your marketplaces made AED 148,993.38 so far, which is not final because the VAT setting for fees has not been chosen. Choose it under Marketplace accounts."
const good = await answerLedgerQuestion("month-summary", input)
check("an honest answer is published", good.narration.ok, JSON.stringify(good.narration))
const lastRequest = sent[sent.length - 1]
check("the model saw the facts and the ledger rules",
  lastRequest?.messages[1]?.content.includes("NOT FINAL") === true &&
    lastRequest?.messages[0]?.content.includes("An expected payout is what a marketplace reports it will pay") === true)
check("and the facts come back with the answer", good.facts === summary)

nextReply = "Your contribution was AED 150,000.00 this month."
const invented = await answerLedgerQuestion("month-summary", input)
check("an invented number discards the answer, and the figures remain",
  !invented.narration.ok && invented.narration.reason === "invented_figures" && invented.facts === summary)

nextReply = "Amazon's AED 24,323.38 has been received."
const received = await answerLedgerQuestion("payouts", input)
check("a received claim discards the answer",
  !received.narration.ok && received.narration.reason === "claimed_received" &&
    received.narration.message.includes("No bank is connected"))

nextReply = "Your final profit is AED 148,993.38."
const final = await answerLedgerQuestion("month-summary", input)
check("a final claim about a not-final figure discards the answer",
  !final.narration.ok && final.narration.reason === "claimed_final")

delete process.env.OPENAI_API_KEY
const off = await answerLedgerQuestion("payouts", input)
check("with no model configured, the figures are still returned",
  !off.narration.ok && off.narration.reason === "not_configured" && off.facts.includes("24,323.38"))

/* -------------------------------------------------------------------------- */
section("4. THE BROWSER SENDS NO FIGURES")

const ACTION = readFileSync("src/features/ledger-ask/actions.ts", "utf8")
check("the action accepts only a question key and a month",
  /z\.object\(\{\s*question: [^\n]+\n\s*month: [^\n]+\n\}\)/.test(ACTION.replace(/\r\n/g, "\n")))
check("the business comes from the session, the figures from the user's own session",
  ACTION.includes("getActiveBusiness()") && ACTION.includes('from "@/lib/supabase/server"') && !/service[_-]?role|callTrusted/i.test(ACTION))
check("no model is called outside the AI layer",
  !ACTION.includes("openai") && !readFileSync("src/features/ledger-ask/components/ledger-ask-panel.tsx", "utf8").includes("openai"))

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
