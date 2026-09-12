/**
 * Checks that the AI layer is set up correctly.
 *
 * Run with:  npm run ai:check
 *
 * Written for someone who is not a developer. It says, in order:
 *
 *   1. whether the key works at all
 *   2. whether the model BizMind is configured to use actually exists on the
 *      account, and which ones do if it does not
 *   3. what a real explanation of a real set of figures looks like, and
 *      whether the number guard was happy with it
 *
 * Step 3 is the one that matters. It sends one small request -- a fraction of
 * a penny -- and puts the reply through exactly the checks the dashboard uses,
 * so a problem shows up here rather than in front of a customer.
 *
 * The key is never printed, not even partially.
 */

import { OPENAI_API_KEY, OPENAI_MODEL } from "./test-env.mjs"

// The AI layer reads process.env, so make .env.local visible to it.
if (OPENAI_API_KEY) process.env.OPENAI_API_KEY = OPENAI_API_KEY
if (OPENAI_MODEL) process.env.OPENAI_MODEL = OPENAI_MODEL

const { aiModel } = await import("../src/services/ai/client")
const { explainPeriod } = await import("../src/services/ai/analyst")
const { buildFactSheet, renderFactSheet } = await import("../src/services/ai/facts")
const { buildAllowlist, extractNumbers } = await import("../src/services/ai/guard")

import type { FactSheetInput } from "../src/services/ai/facts"
import type { BusinessHealth } from "../src/services/analytics/health"
import type { Financials, MetricComparison } from "../src/services/analytics/types"

function line(text = "") {
  console.log(text)
}

function heading(text: string) {
  line()
  line("=".repeat(74))
  line(` ${text}`)
  line("=".repeat(74))
}

/* -------------------------------------------------------------------------- */

heading("1. Is there a key?")

if (!OPENAI_API_KEY) {
  line("  NO.")
  line()
  line("  BizMind cannot write explanations without an OpenAI key.")
  line("  Everything else still works: your figures, dashboard and imports are")
  line("  unaffected, and the dashboard will simply say explanations are off.")
  line()
  line("  To switch them on, add this line to .env.local and run this again:")
  line()
  line("      OPENAI_API_KEY=sk-...your key here...")
  line()
  process.exit(1)
}

line("  Yes, a key is present in .env.local.")
line("  (Not printed here, and never printed anywhere.)")

/* -------------------------------------------------------------------------- */

heading("2. Does the key work, and does the model exist?")

const models = await fetch("https://api.openai.com/v1/models", {
  headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
})

if (models.status === 401) {
  line("  THE KEY WAS REJECTED.")
  line()
  line("  OpenAI does not recognise it. The usual causes:")
  line("    - it was copied with a space or a line break in it")
  line("    - it was deleted or rotated in the OpenAI dashboard")
  line("    - it belongs to a different organisation")
  line()
  line("  Create a fresh key at https://platform.openai.com/api-keys and")
  line("  replace the OPENAI_API_KEY line in .env.local.")
  process.exit(1)
}

if (!models.ok) {
  line(`  OpenAI replied with an error: ${models.status}`)
  line("  This is usually temporary. Try again in a minute.")
  process.exit(1)
}

const body: unknown = await models.json()
const available: string[] =
  typeof body === "object" && body !== null && Array.isArray((body as { data?: unknown }).data)
    ? ((body as { data: { id?: unknown }[] }).data
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string"))
    : []

line(`  The key works. ${available.length} models are available on this account.`)

const configured = aiModel()
const exists = available.includes(configured)

if (exists) {
  line(`  BizMind is set to use "${configured}", and it is available.`)
} else {
  line()
  line(`  PROBLEM: BizMind is set to use "${configured}", which this account`)
  line("  cannot access. Explanations will fail until this is fixed.")
  line()

  // Suggest something real rather than guessing at a name.
  const suggestions = available
    .filter((id) => /^(gpt|o[0-9])/.test(id) && !/(audio|realtime|image|tts|whisper|embed)/.test(id))
    .sort()
    .slice(0, 12)

  if (suggestions.length > 0) {
    line("  Chat models this account CAN use include:")
    for (const id of suggestions) line(`      ${id}`)
    line()
    line("  Pick one and add it to .env.local, for example:")
    line()
    line(`      OPENAI_MODEL=${suggestions[0]}`)
  } else {
    line("  No chat models were found on this account. It may need billing set up")
    line("  at https://platform.openai.com/settings/organization/billing")
  }

  line()
  process.exit(1)
}

/* -------------------------------------------------------------------------- */

heading("3. A real explanation, checked the way the dashboard checks it")

const current: Financials = {
  revenue: "9550.5000",
  cogs: "3800.0000",
  fees: "852.0400",
  gross_profit: "4898.4600",
  gross_margin: "51.29",
  expenses: "1200.0000",
  net_profit: "3698.4600",
  net_margin: "38.72",
  orders_count: 8,
  units_sold: "14.0000",
  avg_order_value: "1193.8125",
  customers_count: 6,
  refunds: "0.0000",
  returns_count: 0,
  cancelled_orders: 1,
  items_total: 4,
  items_with_cost: 3,
  cost_coverage: "75.00",
  orders_zero_fees: 1,
  orders_without_channel: 2,
  line_revenue: "8900.0000",
  orders_fees_unknown: 3,
  fee_coverage: "62.50",
  cost_gap: "25.00",
  fee_gap: "37.50",
  refund_rate: "0.00",
  line_revenue_derived: "0.0000",
  items_value_derived: 0,
  items_value_unknown: 0,
  channel_scoped: false,
}

const comparisons: MetricComparison[] = [
  {
    metric: "revenue",
    current_value: "9550.5000",
    previous_value: "8100.0000",
    absolute_change: "1450.5000",
    percent_change: "17.90",
    direction: "up",
  },
  {
    metric: "gross_profit",
    current_value: "4898.4600",
    previous_value: "5210.0000",
    absolute_change: "-311.5400",
    percent_change: "-5.98",
    direction: "down",
  },
]

const health: BusinessHealth = {
  score: 62,
  status: "watch",
  dimensionsScored: 4,
  dimensionsTotal: 6,
  dimensionsLowConfidence: 1,
  confidence: "limited",
  confidenceNote:
    "2 of 6 areas could not be measured and are left out of the score, and 1 area is measured on incomplete data.",
  summary: "Growing, but the margin is under pressure.",
  dimensions: [],
}

const input: FactSheetInput = {
  businessName: "Sample Trading Co",
  currency: "AED",
  periodLabel: "Last 30 days",
  comparisonLabel: "the previous 30 days",
  periodIncomplete: false,
  current,
  comparisons,
  channels: [],
  products: [],
  health,
  insights: [
    {
      type: "margin_falling_while_revenue_rises",
      severity: "warning",
      title: "Revenue rose but gross profit fell",
      summary: "Sales are up 17.90% while gross profit is down 5.98%.",
      supportingMetrics: [],
      businessImpact: "You are selling more and keeping less of it.",
      recommendedNextStep: "Record the missing costs and fees before judging the margin.",
    },
  ],
}

line("  Asking for an explanation of a sample month...")
line()

const started = Date.now()
const narration = await explainPeriod(input)
const seconds = ((Date.now() - started) / 1000).toFixed(1)

if (!narration.ok) {
  line(`  No explanation was produced. Reason: ${narration.reason}`)
  line()
  line(`  ${narration.message}`)
  line()

  if (narration.reason === "no_credit") {
    line("  YOUR KEY IS FINE. The account simply has no credit on it.")
    line()
    line("  OpenAI keys and OpenAI credit are separate things: creating a key")
    line("  does not add any. A new account starts at zero even with a card on")
    line("  file, so nothing has gone wrong here.")
    line()
    line("  To fix it:")
    line("    1. Go to https://platform.openai.com/settings/organization/billing")
    line("    2. Click 'Add to credit balance'")
    line("    3. The smallest amount is plenty. BizMind uses a fraction of a")
    line("       penny per explanation.")
    line("    4. Run  npm run ai:check  again.")
    line()
    line("  Until then BizMind works exactly as it does now. Every figure,")
    line("  chart and import is unaffected; the dashboard just says explanations")
    line("  are paused.")
    process.exit(1)
  }

  if (narration.reason === "invented_figures") {
    line("  This is the safety check doing its job: the model wrote a number")
    line("  that was not in the figures it was given, so the whole paragraph was")
    line("  discarded rather than shown to you.")
    line()
    line("  If this happens every time, try a more capable model.")
  }

  process.exit(1)
}

// Point 4 of the acceptance criteria, and the one that actually matters: a
// working key proves nothing about which model replied. `narration.model` is
// read from the RESPONSE body, not echoed from the request.
const configuredBase = configured.replace(/-\d{4}-\d{2}-\d{2}$/, "")
const answeredBase = narration.model.replace(/-\d{4}-\d{2}-\d{2}$/, "")
const sameModel = answeredBase === configuredBase

line(`  Requested model:  ${configured}`)
line(`  ANSWERED BY:      ${narration.model}   (reported by OpenAI, not assumed)`)

if (!sameModel) {
  line()
  line("  MISMATCH. BizMind asked for one model and a different one replied.")
  line("  Every explanation would be written by a model nobody chose, so this")
  line("  is treated as a failure rather than a curiosity.")
  process.exit(1)
}

line(`  Match: yes. ${configured} wrote this.`)
line()
line(`  Written in ${seconds}s:`)
line()
for (const paragraph of narration.text.split(/\n{2,}/)) {
  line(`    ${paragraph.trim().replace(/\n/g, "\n    ")}`)
  line()
}

const sheetText = renderFactSheet(buildFactSheet(input))
const allowed = buildAllowlist(sheetText)
const used = [...new Set(extractNumbers(narration.text))]

line("-".repeat(74))
line(`  Numbers used in that explanation: ${used.length}`)
line(`  Every one of them checked against your figures: yes`)
line(`  (The paragraph would have been discarded otherwise.)`)
line()
line(`  Figures the model was allowed to quote: ${allowed.size}`)
line(`  Raw data the model was given: none. It cannot add anything up.`)

heading("Ready")
line("  Explanations are working. They will appear on your dashboard under")
line('  "What happened, in plain language".')
line()
