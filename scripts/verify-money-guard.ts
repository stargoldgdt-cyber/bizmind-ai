/**
 * The money guard: no financial arithmetic in application code.
 *
 * Run with:  npm run test:money-guard
 *
 * WHY THIS EXISTS RATHER THAN A TYPE
 * ----------------------------------
 * This codebase used to claim that typing money as `string` made accidental
 * arithmetic impossible. It did not. Two things were wrong with that claim:
 *
 *   1. The values arrived as JavaScript numbers, so the type was a lie and
 *      `a - b` was ordinary subtraction. Migration 0011 fixed that half.
 *
 *   2. Even with genuinely string-typed money, TypeScript happily allows
 *      `a + b` on two strings. It produces "10002000" instead of 3000 --
 *      silently, and with no type error anywhere.
 *
 * So the type does not enforce the rule and never did. This scanner does, as
 * far as static analysis can, and the rule it enforces is:
 *
 *   Every financial calculation happens in PostgreSQL, in exact decimal.
 *   TypeScript may FORMAT a figure and may COMPARE one against a threshold.
 *   It may not add, subtract, multiply or divide one.
 *
 * A comparison is judgement over a figure the database produced. Arithmetic
 * invents a new figure, and an invented figure has no audit trail.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

/* -------------------------------------------------------------------------- */
/* What counts as money                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every field carrying an exact decimal across the boundary.
 *
 * Ratios are included. A margin is as much a financial figure as a profit, and
 * recomputing one in TypeScript is the same mistake.
 */
const MONEY_FIELDS = [
  "revenue",
  "revenue_previous",
  "cogs",
  "fees",
  "fees_allocated",
  "gross_profit",
  "gross_margin",
  "expenses",
  "net_profit",
  "net_margin",
  "refunds",
  "line_revenue",
  "avg_order_value",
  "units_sold",
  "cost_coverage",
  "cost_gap",
  "fee_coverage",
  "fee_gap",
  "refund_rate",
  "expense_ratio",
  "revenue_growth_pct",
  "repeat_customer_rate",
  "cancelled_rate",
  "payment_capture_rate",
  "paid_order_value",
  "unpaid_order_value",
  "order_revenue",
  "channel_revenue",
  "channel_difference",
  "order_line_gap",
  "current_value",
  "previous_value",
  "absolute_change",
  "percent_change",
  "unit_cost",
  "unit_price",
  "line_total",
  "fee_total",
  "total",
  "subtotal",
  "amount",
  "refund_amount",
]

const FIELD_PATTERN = MONEY_FIELDS.join("|")

/**
 * Files exempt, each for a stated reason. An exemption without a reason is how
 * a rule quietly stops applying.
 */
const EXEMPT: Record<string, string> = {
  "src/lib/format.ts":
    "Display formatting. Hands the exact decimal string to Intl and converts " +
    "nothing. It used to export percentChange(), which computed a figure in " +
    "floating point -- that is gone, and this exemption is honest again.",
  "src/services/analytics/money.ts":
    "The exact decimal comparator itself. Compares digit strings; performs no arithmetic.",
  "src/types/database.ts": "Type declarations only.",
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** Strips comments and string literals so prose cannot trip the scanner. */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ")
}

type Violation = { file: string; line: number; text: string }

/**
 * Arithmetic applied to a money field.
 *
 * Deliberately narrow: it looks for an operator directly beside a money-named
 * property or a Number() call wrapping one. A broad scan would drown in false
 * positives and get switched off, which protects nothing.
 */
const PATTERNS: RegExp[] = [
  // x.revenue - y   /   x.revenue * 2
  new RegExp(String.raw`\.(${FIELD_PATTERN})\s*[-*/]\s*[\w(]`, "g"),
  // y + x.revenue   /   y / x.cogs
  new RegExp(String.raw`[\w)]\s*[-*/]\s*[\w.]*\.(${FIELD_PATTERN})\b`, "g"),
  // Number(x.revenue) - ...   and   ... - Number(x.revenue)
  new RegExp(String.raw`Number\([^)]*\.(${FIELD_PATTERN})[^)]*\)\s*[-*/+]`, "g"),
  new RegExp(String.raw`[-*/+]\s*Number\([^)]*\.(${FIELD_PATTERN})[^)]*\)`, "g"),
  // Arithmetic between bare locals named after money: `refunds / revenue`.
  // The first version of this tried to be clever about declarations and missed
  // exactly that line, which is why the scanner tests itself below.
  new RegExp(
    String.raw`\b(?:revenue|refunds|cogs|fees|profit|margin|expenses|turnover)\s*[-*/]\s*[\w(]`,
    "g"
  ),
]

function scan(file: string): Violation[] {
  const cleaned = stripNoise(readFileSync(file, "utf8"))
  const lines = cleaned.split("\n")
  const found: Violation[] = []

  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(line)) {
        found.push({ file, line: index + 1, text: line.trim().slice(0, 100) })
        return
      }
    }
  })

  return found
}

/* -------------------------------------------------------------------------- */
section("1. NO ARITHMETIC ON A MONEY FIGURE ANYWHERE IN src/")

const files = walk("src")
const violations: Violation[] = []

for (const file of files) {
  const key = file.replace(/\\/g, "/")
  if (EXEMPT[key] !== undefined) continue
  violations.push(...scan(file))
}

check(
  `${files.length} source files scanned, none performs money arithmetic`,
  violations.length === 0,
  violations.map((v) => `${v.file.replace(/\\/g, "/")}:${v.line}  ${v.text}`).join("\n        ")
)

/* -------------------------------------------------------------------------- */
section("2. THE SCANNER ACTUALLY CATCHES THINGS")

// A guard nobody has seen fail is a guard nobody knows works.
const samples = [
  "const profit = a.revenue - b.cogs",
  "const total = Number(x.revenue) + Number(y.revenue)",
  "return Number(b.revenue) - Number(a.revenue)",
  "const rate = (refunds / revenue) * 100",
  "const share = x.gross_profit / x.revenue",
]

for (const sample of samples) {
  const caught = PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(sample)
  })
  check(`caught: ${sample}`, caught)
}

const innocent = [
  "const coverage = Number(current.cost_coverage)",
  "if (Number(c.revenue) > 0) return null",
  "value={formatMoney(current.revenue, currency)}",
  "const missing = current.items_total - current.items_with_cost",
  "compareMoney(b.revenue, a.revenue)",
]

for (const sample of innocent) {
  const caught = PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(sample)
  })
  check(`allowed: ${sample}`, !caught)
}

/* -------------------------------------------------------------------------- */
section("3. THE DISPLAY LAYER DOES NOT CONVERT EITHER")

// The last place exactness can be lost. This file used to call Number() before
// formatting, which showed 9,007,199,254,740,992.00 for a figure the database
// had stored as ...993. Intl accepts the string and rounds it exactly.
const format = readFileSync("src/lib/format.ts", "utf8")

// The lookbehind matters: `formatNumber(` ends in the same six letters, and
// the first version of this check flagged the function's own declaration.
check(
  "formatMoney never converts its input to a number",
  !/(?<![A-Za-z])Number\(/.test(stripNoise(format)),
  (stripNoise(format).match(/(?<![A-Za-z])Number\([^)]*\)/) ?? ["?"])[0]
)
check(
  "and percentChange, which computed a figure in TypeScript, is gone",
  !format.includes("percentChange")
)
check(
  "an unknown figure renders as a dash, never as zero",
  format.includes('const UNKNOWN = "—"') || format.includes("UNKNOWN")
)

/* -------------------------------------------------------------------------- */
section("4. NOTHING REACHES A FUNCTION THAT STILL RETURNS numeric")

// dashboard_summary() and channel_performance() predate the text boundary and
// still return numeric. They are dead code, and DATABASE.md says so. This is
// what stops that documented inconsistency becoming a live one.
const stale = ["dashboard_summary", "channel_performance", "analytics_counted_orders"]

for (const fn of stale) {
  const callers = files.filter((file) => readFileSync(file, "utf8").includes(`"${fn}"`))
  check(
    `nothing in src/ calls ${fn}()`,
    callers.length === 0,
    callers.join(", ")
  )
}

/* -------------------------------------------------------------------------- */
section("5. THE CLAIM MADE IN THE DOCS MATCHES THE MECHANISM")

const database = readFileSync("src/types/database.ts", "utf8")
const analytics = readFileSync("src/services/analytics/types.ts", "utf8")

check(
  "no file still claims the type system prevents arithmetic",
  !/impossible to do financial\s+\*?\s*arithmetic/i.test(database + analytics),
)
check(
  "the real guarantee is stated instead: exact text from SQL",
  /exact/i.test(analytics) && /text/i.test(analytics)
)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
