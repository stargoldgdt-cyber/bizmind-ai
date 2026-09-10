/**
 * The automation engine, without a database.
 *
 * Run with:  npm run test:automation
 *
 * WHAT THIS CAN AND CANNOT PROVE
 * ------------------------------
 * The comparison itself lives in SQL, so it is not testable here -- and that
 * is the point of putting it there. What IS testable offline is everything
 * around it: that a rule which could never fire cannot be saved, that a
 * threshold survives as exact text, that the TypeScript and SQL vocabularies
 * agree, and that no financial arithmetic has crept into this service.
 *
 * `scripts/verify-automation-live.mts` covers the evaluation itself against a
 * real database, including the cases where a rule must stay silent.
 */

import { readFileSync } from "node:fs"

import {
  AUTOMATION_OPERATORS,
  COMPARABLE_ANALYTICS_KEYS,
  canWatch,
  createRuleSchema,
  explainSkip,
  isChangeOperator,
  updateRuleSchema,
  watchableMetrics,
} from "../src/services/automation/contracts"
import { RULE_TEMPLATES, getRuleTemplate } from "../src/services/automation/templates"
import { CANONICAL_METRICS } from "../src/services/metrics/canonical"

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

const MIGRATION_0016 = readFileSync("supabase/migrations/0016_automation_engine.sql", "utf8")
const MIGRATION_0017 = readFileSync("supabase/migrations/0017_alert_operator.sql", "utf8")

/** A valid rule, used as the base for the negative cases below. */
const VALID = {
  name: "Gross margin below 15%",
  description: null,
  metric: "gross_margin",
  operator: "LT" as const,
  threshold: "15",
  period_days: 30,
  severity: "WARNING" as const,
  cooldown_hours: 24,
  evaluate_every_minutes: 60,
  suppress_when_incomplete: true,
}

/* ========================================================================== */
section("1. A RULE THAT COULD NEVER FIRE CANNOT BE SAVED")
/* ========================================================================== */

check(
  "a valid rule is accepted",
  createRuleSchema.safeParse(VALID).success
)

check(
  "a metric BizMind does not define is refused",
  !createRuleSchema.safeParse({ ...VALID, metric: "profit_margin_pct" }).success,
  "the FK would refuse it anyway, but the message should arrive first"
)

/**
 * The important one. `payment_received` is a real canonical metric with no
 * analyticsKey -- the analytics engine does not publish it. A rule on it would
 * save, look correct in the list, and never fire.
 */
const unpublished = Object.values(CANONICAL_METRICS).find((m) => !m.analyticsKey)

check(
  "a metric the analytics engine does not publish is refused",
  unpublished !== undefined &&
    !createRuleSchema.safeParse({ ...VALID, metric: unpublished.key }).success,
  `checked with "${unpublished?.key}"`
)

check(
  "and the refusal says why, in the owner's language",
  (() => {
    if (!unpublished) return false
    const result = canWatch(unpublished.key, "LT")
    return !result.ok && result.reason.includes("could never fire")
  })()
)

check(
  "a percentage-change rule on a metric with no comparison is refused",
  (() => {
    // fee_coverage is published, so a value rule works -- but
    // analytics_compare() produces no row for it.
    const value = canWatch("fee_coverage", "LT")
    const change = canWatch("fee_coverage", "CHANGE_PCT_LT")
    return value.ok && !change.ok
  })(),
  "otherwise the rule saves and silently returns nothing forever"
)

check(
  "an empty name is refused",
  !createRuleSchema.safeParse({ ...VALID, name: "   " }).success
)

check(
  "a period longer than a year is refused",
  !createRuleSchema.safeParse({ ...VALID, period_days: 400 }).success
)

check(
  "an evaluation interval under five minutes is refused",
  !createRuleSchema.safeParse({ ...VALID, evaluate_every_minutes: 1 }).success
)

check(
  "a cooldown of zero is ALLOWED",
  createRuleSchema.safeParse({ ...VALID, cooldown_hours: 0 }).success,
  "noisy, but a legitimate choice for a genuinely critical rule"
)

check(
  "an update must say whether the rule is enabled",
  !updateRuleSchema.safeParse(VALID).success &&
    updateRuleSchema.safeParse({ ...VALID, enabled: true }).success,
  "a partial update that dropped `enabled` would silently switch a rule off"
)

check(
  "an update is held to the same checks as a create",
  !updateRuleSchema.safeParse({ ...VALID, enabled: true, threshold: "$15" })
    .success,
  "editing a rule must not be a way around validation"
)

/* ---- What the UI is allowed to offer ---- */

const offered = watchableMetrics()

check(
  "watchableMetrics offers only metrics the analytics engine publishes",
  offered.every((m) => m.analyticsKey !== undefined) && offered.length > 0,
  `${offered.length} offered`
)

check(
  "it offers every one of them",
  offered.length ===
    Object.values(CANONICAL_METRICS).filter((m) => m.analyticsKey).length
)

check(
  "and every metric it offers can actually be watched",
  offered.every((m) => canWatch(m.key, "LT").ok),
  "offering one that cannot is promising an alert that will never arrive"
)

/* ========================================================================== */
section("2. THE THRESHOLD IS EXACT TEXT, START TO FINISH")
/* ========================================================================== */

check(
  "a threshold is accepted as a string",
  createRuleSchema.safeParse({ ...VALID, threshold: "15.1500" }).success
)

check(
  "and comes back out byte-for-byte, not reformatted",
  (() => {
    const parsed = createRuleSchema.safeParse({ ...VALID, threshold: "15.1500" })
    return parsed.success && parsed.data.threshold === "15.1500"
  })(),
  "a threshold that changed on the way in is a rule firing on the wrong line"
)

check(
  "a number is refused, not silently coerced",
  !createRuleSchema.safeParse({
    ...VALID,
    threshold: 15 as unknown as string,
  }).success,
  "z.number() would have made 15.15 into a double before it reached SQL"
)

check(
  "a currency symbol is refused",
  !createRuleSchema.safeParse({ ...VALID, threshold: "$15" }).success
)

check(
  "a thousands separator is refused",
  !createRuleSchema.safeParse({ ...VALID, threshold: "1,500" }).success,
  "1,500 parsed loosely becomes 1 -- a threshold 1500x too low"
)

check(
  "a percent sign is refused",
  !createRuleSchema.safeParse({ ...VALID, threshold: "15%" }).success
)

check(
  "a negative threshold is accepted",
  createRuleSchema.safeParse({
    ...VALID,
    metric: "revenue",
    operator: "CHANGE_PCT_LT",
    threshold: "-20",
  }).success,
  "a 20% fall IS a threshold of -20"
)

check(
  "more than four decimal places is refused",
  !createRuleSchema.safeParse({ ...VALID, threshold: "15.123456" }).success,
  "numeric(20,4) would round it, and the stored rule would differ from the typed one"
)

check(
  "a percentage threshold in the thousands is caught",
  !createRuleSchema.safeParse({ ...VALID, threshold: "1500" }).success,
  "gross margin over 1500% is somebody entering money into a margin rule"
)

check(
  "but a large threshold on a MONEY metric is fine",
  createRuleSchema.safeParse({
    ...VALID,
    metric: "revenue",
    operator: "LT",
    threshold: "1500",
  }).success
)

/* ========================================================================== */
section("3. TYPESCRIPT AND SQL AGREE ON THE VOCABULARY")
/* ========================================================================== */

check(
  "every operator in TypeScript exists in the SQL enum",
  AUTOMATION_OPERATORS.every((op) =>
    new RegExp(`'${op}'`).test(MIGRATION_0016)
  )
)

check(
  "the comparable-metric list matches the one inside the evaluator",
  COMPARABLE_ANALYTICS_KEYS.every((key) =>
    new RegExp(`'${key}'`).test(MIGRATION_0016)
  ),
  "a divergence here is a rule that saves and never fires"
)

check(
  "every analyticsKey in canonical.ts is mapped by the migration",
  Object.values(CANONICAL_METRICS)
    .filter((m) => m.analyticsKey)
    .every(
      (m) =>
        MIGRATION_0016.includes(`= '${m.analyticsKey}'`) ||
        new RegExp(`'${m.key}'`).test(MIGRATION_0016)
    ),
  "the migration asserts this too, and refuses to install if it fails"
)

check(
  "isChangeOperator agrees with the operator names",
  AUTOMATION_OPERATORS.every(
    (op) => isChangeOperator(op) === op.startsWith("CHANGE_PCT_")
  )
)

check(
  "every skip reason the migration can write has an explanation",
  ["COOLDOWN", "METRIC_NULL", "INCOMPLETE_DATA", "DISABLED",
   "NO_ANALYTICS_KEY", "NO_COMPARISON"].every(
    (reason) =>
      MIGRATION_0016.includes(`'${reason}'`) && explainSkip(reason) !== null
  ),
  "a reason with no explanation reaches the owner as a raw enum"
)

check(
  "an unknown skip reason still produces a sentence",
  explainSkip("SOMETHING_NEW") !== null
)

check(
  "no reason at all produces nothing",
  explainSkip(null) === null
)

/* ========================================================================== */
section("4. THE STARTER RULES ARE HONEST")
/* ========================================================================== */

for (const template of RULE_TEMPLATES) {
  check(
    `template "${template.id}" is a rule that would validate`,
    createRuleSchema.safeParse(template.rule).success,
    JSON.stringify(
      createRuleSchema.safeParse(template.rule).success
        ? {}
        : createRuleSchema.safeParse(template.rule)
    ).slice(0, 160)
  )
}

check(
  "every template says why its threshold was chosen",
  RULE_TEMPLATES.every((t) => t.rationale.length > 40),
  "a guessed threshold presented without its reasoning reads as authoritative"
)

check(
  "the cost-coverage rule does NOT suppress on incomplete data",
  getRuleTemplate("cost_coverage")?.rule.suppress_when_incomplete === false,
  "it exists to report incomplete data; suppressing it would silence the " +
    "one alert that explains why the others went quiet"
)

check(
  "the profit rules DO suppress on incomplete data",
  ["margin_floor"].every(
    (id) => getRuleTemplate(id)?.rule.suppress_when_incomplete === true
  )
)

check(
  "no template watches a refund RATE, which does not exist as a metric",
  !RULE_TEMPLATES.some(
    (t) => t.rule.metric === "refunds" && !isChangeOperator(t.rule.operator)
  ),
  "refunds is a money amount; a fixed threshold on it means something " +
    "different for every business"
)

/* ========================================================================== */
section("5. NO FINANCIAL ARITHMETIC ENTERS THIS SERVICE")
/* ========================================================================== */

const SERVICE_FILES = [
  "src/services/automation/contracts.ts",
  "src/services/automation/rules.ts",
  "src/services/automation/alerts.ts",
  "src/services/automation/worker.ts",
  "src/services/automation/templates.ts",
]

/** Comments explain the rules; they must not be mistaken for breaking them. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

for (const file of SERVICE_FILES) {
  const code = withoutComments(readFileSync(file, "utf8"))

  check(
    `${file.split("/").pop()} does not convert a figure to a number`,
    !/\b(parseFloat|parseInt|Number)\s*\(/.test(code)
  )
}

check(
  "the worker never sees a metric value or a threshold",
  (() => {
    const code = withoutComments(
      readFileSync("src/services/automation/worker.ts", "utf8")
    )
    return !code.includes("threshold") && !code.includes("metric_value")
  })(),
  "the comparison is the database's job; the worker only reacts to outcomes"
)

check(
  "the worker takes no business id",
  (() => {
    const code = withoutComments(
      readFileSync("src/services/automation/worker.ts", "utf8")
    )
    return !/business_?[iI]d/.test(code)
  })(),
  "callTrusted() refuses one, and this is why it can"
)

/* ========================================================================== */
section("6. THE PRIVILEGED PATH STAYS NARROW")
/* ========================================================================== */

const PRIVILEGED = readFileSync(
  "src/services/integrations/security/privileged.ts",
  "utf8"
)

check(
  "the two automation functions are on the trusted allowlist",
  PRIVILEGED.includes('"automation_claim_due"') &&
    PRIVILEGED.includes('"automation_evaluate_rule"')
)

check(
  "automation_evaluate_business is NOT",
  !PRIVILEGED.includes('"automation_evaluate_business"'),
  "it takes a business id, so it must never be reachable with the service key"
)

check(
  "the refusal of business-id arguments is still in place",
  PRIVILEGED.includes('"p_business_id" in args')
)

const TYPES = readFileSync("src/types/database.ts", "utf8")

check(
  "automation_claim_due is not typed on the session-scoped client",
  !TYPES.includes("automation_claim_due:"),
  "typing it would put a cross-tenant function within reach of a user session"
)

/* ========================================================================== */
section("7. THE MIGRATIONS GUARD THEMSELVES")
/* ========================================================================== */

for (const [name, sql] of [
  ["0016", MIGRATION_0016],
  ["0017", MIGRATION_0017],
] as const) {
  check(
    `migration ${name} runs in a transaction`,
    /^begin;/m.test(sql) && /^commit;/m.test(sql),
    "a half-applied security migration is worse than none"
  )

  check(
    `migration ${name} asserts its own guarantees before committing`,
    sql.includes("raise exception"),
  )
}

check(
  "0016 revokes default privileges before granting",
  MIGRATION_0016.indexOf("revoke all on public.%I from anon") <
    MIGRATION_0016.indexOf("grant select, insert, update, delete"),
  "Supabase grants ALL to anon and authenticated before a migration runs"
)

check(
  "0016 forces RLS, not just enables it",
  MIGRATION_0016.includes("force row level security")
)

check(
  "0016 refuses to install if anon can read any automation table",
  MIGRATION_0016.includes("SECURITY: anon can read public.%")
)

check(
  "0016 refuses to install if authenticated can claim across tenants",
  MIGRATION_0016.includes("automation_claim_due, which reads")
)

check(
  "0016 casts enum literals explicitly",
  MIGRATION_0016.includes("::public.automation_run_status"),
  "a CASE of bare literals is text -- the 42804 fault that broke every " +
    "webhook delivery in 0012"
)

check(
  "0017 makes the operator column NOT NULL",
  MIGRATION_0017.includes("alter column operator set not null")
)

check(
  "0017 reissues the function grants rather than assuming they survived",
  MIGRATION_0017.includes("grant execute on function public.automation_evaluate_rule")
)

/* ========================================================================== */

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
