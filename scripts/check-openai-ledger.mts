/**
 * The live model check for Ask BizMind on the marketplace ledger (GCC Phase 9).
 *
 * Run with:  npm run ai:check-ledger
 *
 * Sends two small questions -- a month that is not final, and expected
 * payouts -- built from INVENTED figures, through exactly the checks the page
 * uses, and prints what came back and whether it was published. Costs a
 * fraction of a penny. The key is never printed.
 */

import { OPENAI_API_KEY, OPENAI_MODEL } from "./test-env.mjs"

if (OPENAI_API_KEY) process.env.OPENAI_API_KEY = OPENAI_API_KEY
if (OPENAI_MODEL) process.env.OPENAI_MODEL = OPENAI_MODEL

const { answerLedgerQuestion } = await import("../src/services/ai/analyst")
const { aiModel, isAiConfigured } = await import("../src/services/ai/client")

import type { LedgerFactInput } from "../src/services/ai/ledger-facts"

if (!isAiConfigured()) {
  console.log("\n  No OpenAI key is configured, so written answers are off. The figures still show on every question.\n")
  process.exit(0)
}

const input: LedgerFactInput = {
  businessName: "Invented Trading",
  monthLabel: "July 2026",
  perCurrency: [{
    marketplace_account_id: "", account_label: "All AED accounts", marketplace_code: "MIXED", currency: "AED",
    period_from: "2026-07-01T00:00:00Z", period_to: "2026-08-01T00:00:00Z", gross_sales: "214520.1900",
    sales_refunds: "-5242.1300", seller_discounts: "-281.7700", net_sales: "208996.2900", other_income: "12292.6200",
    marketplace_fees: "-31348.6300", fulfillment: "-31485.2800", advertising: "-9656.8900", other_marketplace_costs: "0.0000",
    non_recoverable_vat: "0.0000", contribution: null, contribution_status: "INCOMPLETE",
    contribution_before_open_items: "148993.3800", figures_status: "FINAL", input_vat_recoverable: "0.0000",
    input_vat_unresolved: "-2367.5700", output_vat: "-7051.2800", input_vat_treatment: "UNKNOWN", lines: 5342,
    unknown_lines: 0, unknown_amount: "0.0000", review_lines: 0, review_amount: "0.0000", conditional_lines: 2,
    row_errors: 0, incomplete_reasons: ["VAT_TREATMENT_UNKNOWN"], accounts: 2, units_sold: "1700.0000", cogs: "0.0000",
    units_without_product: "1700.0000", units_without_cost: "0.0000", sales_without_cost: "200000.0000",
    gross_profit: null, gross_profit_status: "INCOMPLETE", gross_profit_before_open_items: "148993.3800",
    gross_profit_reasons: ["VAT_TREATMENT_UNKNOWN", "SKU_NOT_MAPPED"],
  }],
  net: [],
  payouts: [{
    payout_key: "k", source: "SETTLEMENT_REPORT", marketplace_account_id: "a", account_label: "Amazon.ae",
    marketplace_code: "AMAZON", currency: "AED", reference: "INVENTED", source_file_id: null, file_name: null,
    period_start: null, period_end: null, expected_date: "2026-07-18T08:00:00Z", expected_amount: "24323.3800",
    settlement_lines_total: "24323.3800", settlement_lines: 300, marketplace_status: "ADDS_UP",
    bank_receipt_status: "NOT_CONNECTED", bank_receipt_amount: null, bank_receipt_date: null,
  }],
}

console.log(`\n  Model: ${aiModel()}\n`)
let published = 0
for (const question of ["month-summary", "payouts"] as const) {
  const { narration } = await answerLedgerQuestion(question, input)
  console.log(`  ${question}: ${narration.ok ? `PUBLISHED (answered by ${narration.model})` : `DISCARDED -- ${narration.reason}`}`)
  console.log(narration.ok ? `    ${narration.text.replace(/\n/g, "\n    ")}\n` : `    ${narration.message}\n`)
  if (narration.ok) published += 1
}
console.log(`  ${published} of 2 answers passed every check.`)
console.log("  A discarded answer is the guard working, not a fault; the figures are shown either way.\n")
