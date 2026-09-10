/**
 * The automation engine, against the real database.
 *
 * Run with:  npm run test:automation-live
 *
 * The offline suite proves the rules a person can write. This one proves the
 * part only PostgreSQL can: that the comparison is right, that a rule stays
 * silent when it should, and that Business A cannot see, edit, run or
 * acknowledge anything belonging to Business B.
 *
 * THE MOST IMPORTANT ASSERTIONS HERE ARE THE ONES ABOUT SILENCE.
 *
 * Anyone can make an alert fire. The failures that would actually hurt a
 * business are the quiet ones: a rule that fires on a margin inflated by
 * missing costs, a rule that reads an empty period as a collapse to zero, a
 * rule that pages somebody forty times in an afternoon. Sections 3, 4 and 5
 * exist for those.
 *
 * Everything runs in throwaway tenants that are deleted at the end.
 */

import { CANONICAL_METRICS } from "../src/services/metrics/canonical"
import { requireConfig, SUPABASE_SERVICE_ROLE_KEY } from "./test-env.mjs"

let passed = 0
let failed = 0
let skipped = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`)
  }
}

function skip(name: string, why: string) {
  skipped += 1
  console.log(`  SKIP  ${name} -- ${why}`)
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

const {
  url: SUPABASE_URL,
  anonKey: ANON_KEY,
  email: EMAIL,
  password: PASSWORD,
  otherEmail: OTHER_EMAIL,
  otherPassword: OTHER_PASSWORD,
} = requireConfig({ second: true })

const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY ?? ""
const HAS_SERVICE_KEY = SERVICE_KEY.length > 20

/* ---- REST helpers -------------------------------------------------------- */

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    console.error(`Could not sign in as ${email}.`)
    process.exit(1)
  }
  return (await response.json()).access_token
}

let token = ""

async function api(path: string, init: RequestInit = {}, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Authorization: `Bearer ${asToken}`,
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`)
  return body
}

async function attempt(path: string, init: RequestInit = {}, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Authorization: `Bearer ${asToken}`,
      ...(init.headers ?? {}),
    },
  })
  return { ok: response.ok, status: response.status, body: await response.text() }
}

const rpc = (fn: string, args: unknown, asToken = token) =>
  api(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

const tryRpc = (fn: string, args: unknown, asToken = token) =>
  attempt(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

async function serviceRpc(fn: string, args: unknown) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : null }
}

/** Days ago, as an ISO timestamp. Dates only -- no money arithmetic. */
function daysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString()
}

/* ---- Setup --------------------------------------------------------------- */

token = await signIn(EMAIL, PASSWORD)
const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)

section("Setup")
const suffix = Date.now().toString(36)

const business = await rpc("create_business", {
  p_name: `Automation A ${suffix}`,
  p_slug: `automation-a-${suffix}`,
  p_currency: "AED",
})
const businessId = business.id as string

const rival = await rpc(
  "create_business",
  { p_name: `Automation B ${suffix}`, p_slug: `automation-b-${suffix}`, p_currency: "AED" },
  otherToken
)
const rivalId = rival.id as string

const [channel] = await api("/rest/v1/channels", {
  method: "POST",
  body: JSON.stringify({ business_id: businessId, name: "Website", type: "WEBSITE" }),
})

/**
 * Seeds one order.
 *
 * `cost` is nullable on purpose: a line with no cost is what makes cost
 * coverage fall short, which is what sections 4 tests.
 */
async function order(
  number: string,
  placedAt: string,
  total: string,
  fee: string,
  lines: { sku: string; qty: string; price: string; cost: string | null; lineTotal: string }[]
) {
  const [row] = await api("/rest/v1/orders", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      channel_id: channel.id,
      order_number: number,
      status: "FULFILLED",
      currency: "AED",
      subtotal: total,
      fee_total: fee,
      total,
      placed_at: placedAt,
    }),
  })

  for (const line of lines) {
    await api("/rest/v1/order_items", {
      method: "POST",
      body: JSON.stringify({
        business_id: businessId,
        order_id: row.id,
        sku: line.sku,
        name: line.sku,
        quantity: line.qty,
        unit_price: line.price,
        unit_cost: line.cost,
        line_total: line.lineTotal,
      }),
    })
  }
}

/**
 * The current period: 1000 revenue, 900 cost. Gross margin 10%, well under a
 * 15% floor -- and every line HAS a cost, so coverage is 100% and a profit
 * rule is allowed to judge it.
 */
await order("CUR-1", daysAgo(3), "1000", "0", [
  { sku: "WIDGET", qty: "10", price: "100", cost: "90", lineTotal: "1000" },
])

/** The period before: 5000 revenue, so the current period is a large fall. */
await order("PREV-1", daysAgo(20), "5000", "0", [
  { sku: "WIDGET", qty: "50", price: "100", cost: "90", lineTotal: "5000" },
])

console.log(`  tenant A: ${business.name}`)
console.log(`  tenant B: ${rival.name} (a different person)`)
console.log(`  seeded: 1000 revenue in the last 14 days, 5000 in the 14 before`)
console.log(`  service-role key: ${HAS_SERVICE_KEY ? "present" : "ABSENT -- worker section will be skipped"}`)

const createdRules: string[] = []

async function makeRule(fields: Record<string, unknown>) {
  const [row] = await api("/rest/v1/automation_rules", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      period_days: 14,
      severity: "WARNING",
      cooldown_hours: 24,
      evaluate_every_minutes: 60,
      suppress_when_incomplete: true,
      ...fields,
    }),
  })
  createdRules.push(row.id)
  return row
}

try {
  /* ---------------------------------------------------------------------- */
  section("1. THE VOCABULARY IS REAL")

  const metrics = await api(
    "/rest/v1/canonical_metrics?select=key,analytics_key&order=key"
  )

  check(
    "canonical_metrics now carries an analytics_key",
    metrics.length > 0 && "analytics_key" in metrics[0]
  )

  const published: { key: string; analytics_key: string }[] = metrics.filter(
    (m: { analytics_key: string | null }) => m.analytics_key
  )

  /**
   * Derived from the registry, never hardcoded.
   *
   * A literal count here is a number that has to be remembered and updated,
   * and the first version of this test asserted 16 when the answer was 15 --
   * a failing test that said nothing was wrong with the product, which is the
   * kind of noise that gets suites ignored.
   */
  const expected = Object.values(CANONICAL_METRICS).filter((m) => m.analyticsKey)

  check(
    "the database maps exactly as many metrics as the registry does",
    published.length === expected.length,
    `database ${published.length}, registry ${expected.length}`
  )

  check(
    "and every single mapping agrees, key by key",
    expected.every(
      (m) =>
        published.find((p) => p.key === m.key)?.analytics_key === m.analyticsKey
    ) &&
      published.every((p) =>
        expected.some(
          (m) => m.key === p.key && m.analyticsKey === p.analytics_key
        )
      ),
    "drift in either direction is a rule that saves and never fires"
  )

  check(
    "marketplace_fees maps to the column actually called fees",
    metrics.find((m: { key: string }) => m.key === "marketplace_fees")
      ?.analytics_key === "fees",
    "the rename is exactly what a rule would otherwise silently miss"
  )

  const bad = await attempt("/rest/v1/automation_rules", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      name: `Invented metric ${suffix}`,
      metric: "profitability",
      operator: "LT",
      threshold: "15",
    }),
  })

  check(
    "a rule on a metric BizMind does not define is REFUSED by the database",
    !bad.ok,
    `status ${bad.status}`
  )

  /* ---------------------------------------------------------------------- */
  section("2. A RULE FIRES ON THE RIGHT SIDE OF THE LINE")

  const marginRule = await makeRule({
    name: `Margin floor ${suffix}`,
    metric: "gross_margin",
    operator: "LT",
    threshold: "15",
    // Every seeded line has a cost, but fees are unknown on these orders, so
    // fee coverage is short. This rule is about the comparison, not the gate.
    suppress_when_incomplete: false,
  })

  const fired = await rpc("automation_evaluate_rule", { p_rule_id: marginRule.id })

  check(
    "gross margin of 10% against a floor of 15% FIRES",
    fired.status === "FIRED",
    `status ${fired.status}, reason ${fired.skipped_reason}, value ${fired.metric_value}`
  )

  check(
    "the run records the exact value it compared",
    typeof fired.metric_value === "string" && fired.metric_value.startsWith("10"),
    String(fired.metric_value)
  )

  const [raised] = await api(`/rest/v1/alerts?run_id=eq.${fired.id}`)

  check("an alert was raised", raised !== undefined)

  check(
    "the alert copied the value, not a reference to the rule",
    raised?.metric_value === fired.metric_value && raised?.threshold === "15"
  )

  check(
    "the alert records HOW it was compared",
    raised?.operator === "LT",
    "without this a percentage change and a money figure are indistinguishable"
  )

  check(
    "the alert opens unacknowledged",
    raised?.status === "OPEN"
  )

  const [audit] = await api(
    `/rest/v1/audit_logs?entity_id=eq.${raised?.id}&action=eq.automation.alert.raised`
  )

  check("raising an alert is written to the audit log", audit !== undefined)

  /* ---- The other side of the line ---- */

  const comfortableRule = await makeRule({
    name: `Margin comfortable ${suffix}`,
    metric: "gross_margin",
    operator: "LT",
    threshold: "5",
    suppress_when_incomplete: false,
  })

  const quiet = await rpc("automation_evaluate_rule", { p_rule_id: comfortableRule.id })

  check(
    "the same margin against a floor of 5% does NOT fire",
    quiet.status === "NOT_MATCHED",
    `status ${quiet.status}`
  )

  check(
    "and the check is still recorded, so silence is explainable",
    quiet.id !== undefined && quiet.metric_value === fired.metric_value
  )

  /* ---- A percentage change ---- */

  const dropRule = await makeRule({
    name: `Revenue drop ${suffix}`,
    metric: "revenue",
    operator: "CHANGE_PCT_LT",
    threshold: "-20",
    suppress_when_incomplete: false,
  })

  const drop = await rpc("automation_evaluate_rule", { p_rule_id: dropRule.id })

  check(
    "revenue falling from 5000 to 1000 fires a 20% drop rule",
    drop.status === "FIRED",
    `status ${drop.status}, value ${drop.metric_value}`
  )

  check(
    "the recorded change is negative, as a fall must be",
    typeof drop.metric_value === "string" && drop.metric_value.startsWith("-"),
    String(drop.metric_value)
  )

  /* ---------------------------------------------------------------------- */
  section("3. A MISSING FIGURE NEVER BECOMES ZERO")

  const emptyRule = await makeRule({
    name: `Empty period ${suffix}`,
    metric: "gross_margin",
    operator: "LT",
    threshold: "15",
    // One day, in a tenant whose only orders are 3 and 20 days old.
    period_days: 1,
    suppress_when_incomplete: false,
  })

  const empty = await rpc("automation_evaluate_rule", { p_rule_id: emptyRule.id })

  check(
    "a period with no orders is SKIPPED, not read as a margin of zero",
    empty.status === "SKIPPED" && empty.skipped_reason === "METRIC_NULL",
    `status ${empty.status}, reason ${empty.skipped_reason}, value ${empty.metric_value}`
  )

  check(
    "and no alert was raised for it",
    (await api(`/rest/v1/alerts?run_id=eq.${empty.id}`)).length === 0,
    "a zero margin would look like a catastrophe on a quiet day"
  )

  /* ---------------------------------------------------------------------- */
  section("4. AN UNRELIABLE FIGURE DOES NOT RAISE AN ALARM")

  // A second order with NO unit cost drags cost coverage below 100%.
  await order("CUR-2", daysAgo(2), "500", "0", [
    { sku: "MYSTERY", qty: "5", price: "100", cost: null, lineTotal: "500" },
  ])

  const gatedRule = await makeRule({
    name: `Margin gated ${suffix}`,
    metric: "gross_margin",
    operator: "LT",
    threshold: "15",
    suppress_when_incomplete: true,
  })

  const gated = await rpc("automation_evaluate_rule", { p_rule_id: gatedRule.id })

  check(
    "a profit rule is SKIPPED while costs are incomplete",
    gated.status === "SKIPPED" && gated.skipped_reason === "INCOMPLETE_DATA",
    `status ${gated.status}, reason ${gated.skipped_reason}`
  )

  check(
    "the run still records the figure it would have used",
    gated.metric_value !== null,
    "so an owner can see what was withheld and why"
  )

  /**
   * The reason the gate exists, demonstrated rather than asserted in prose.
   *
   * Adding an order with no recorded cost RAISES the reported gross margin:
   * revenue grows and cost does not. An owner watching that number would see
   * their margin improve at the moment their data got worse -- and a rule
   * firing or not firing on it is reporting an artefact of missing data.
   */
  check(
    "an uncosted order MOVED the reported margin",
    gated.metric_value !== fired.metric_value,
    `was ${fired.metric_value}, now ${gated.metric_value} -- same period, ` +
      "same real trading, one order whose cost nobody recorded"
  )

  const coverageRule = await makeRule({
    name: `Coverage ${suffix}`,
    metric: "cost_coverage",
    operator: "LT",
    threshold: "100",
    // The rule that REPORTS incomplete data must not be gated by it.
    suppress_when_incomplete: false,
  })

  const coverage = await rpc("automation_evaluate_rule", { p_rule_id: coverageRule.id })

  check(
    "but the rule that reports the gap itself still fires",
    coverage.status === "FIRED",
    `status ${coverage.status}, value ${coverage.metric_value}`
  )

  /* ---------------------------------------------------------------------- */
  section("5. A RULE DOES NOT REPEAT ITSELF")

  const again = await rpc("automation_evaluate_rule", { p_rule_id: marginRule.id })

  check(
    "firing twice inside the cooldown is SKIPPED",
    again.status === "SKIPPED" && again.skipped_reason === "COOLDOWN",
    `status ${again.status}, reason ${again.skipped_reason}`
  )

  check(
    "and no second alert exists",
    (await api(`/rest/v1/alerts?rule_id=eq.${marginRule.id}`)).length === 1,
    "a metric resting on its threshold would otherwise page somebody hourly"
  )

  /**
   * Watches cost coverage, not margin.
   *
   * Section 4 has just added an order with no cost, which pushed the reported
   * margin ABOVE 15 -- so a margin rule here would correctly not match, and
   * the assertion below would fail for a reason that has nothing to do with
   * cooldowns. Coverage is short and stays short, so this rule tests the one
   * thing it is meant to.
   */
  const noCooldown = await makeRule({
    name: `No cooldown ${suffix}`,
    metric: "cost_coverage",
    operator: "LT",
    threshold: "100",
    cooldown_hours: 0,
    suppress_when_incomplete: false,
  })

  await rpc("automation_evaluate_rule", { p_rule_id: noCooldown.id })
  const second = await rpc("automation_evaluate_rule", { p_rule_id: noCooldown.id })

  check(
    "a cooldown of zero really does allow an immediate re-fire",
    second.status === "FIRED",
    `status ${second.status} -- deliberate, and the reason zero is not the default`
  )

  /* ---- Disabled ---- */

  await api(`/rest/v1/automation_rules?id=eq.${noCooldown.id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  })

  const disabled = await rpc("automation_evaluate_rule", { p_rule_id: noCooldown.id })

  check(
    "a disabled rule is SKIPPED with a reason, not silently ignored",
    disabled.status === "SKIPPED" && disabled.skipped_reason === "DISABLED"
  )

  /* ---------------------------------------------------------------------- */
  section("6. ACKNOWLEDGING")

  const acked = await rpc("alert_acknowledge", { p_alert_id: raised.id })

  check("an open alert can be acknowledged", acked.status === "ACKNOWLEDGED")
  check("and the person who did it is recorded", acked.acknowledged_by !== null)

  const twice = await tryRpc("alert_acknowledge", { p_alert_id: raised.id })

  check(
    "acknowledging an already-acknowledged alert is refused",
    !twice.ok,
    "otherwise the timestamp would move every time somebody clicked"
  )

  /* ---------------------------------------------------------------------- */
  section("7. TENANT ISOLATION")

  const rivalSees = await api(
    `/rest/v1/automation_rules?business_id=eq.${businessId}`,
    {},
    otherToken
  )

  check(
    "B cannot read A's rules",
    rivalSees.length === 0,
    `saw ${rivalSees.length}`
  )

  const rivalAlerts = await api(
    `/rest/v1/alerts?business_id=eq.${businessId}`,
    {},
    otherToken
  )

  check("B cannot read A's alerts", rivalAlerts.length === 0)

  const rivalRuns = await api(
    `/rest/v1/automation_runs?business_id=eq.${businessId}`,
    {},
    otherToken
  )

  check("B cannot read A's evaluation history", rivalRuns.length === 0)

  const rivalWrite = await attempt(
    "/rest/v1/automation_rules",
    {
      method: "POST",
      body: JSON.stringify({
        business_id: businessId,
        name: `Planted ${suffix}`,
        metric: "revenue",
        operator: "LT",
        threshold: "1",
      }),
    },
    otherToken
  )

  check(
    "B cannot plant a rule in A's business",
    !rivalWrite.ok,
    `status ${rivalWrite.status}`
  )

  const rivalRun = await tryRpc(
    "automation_evaluate_rule",
    { p_rule_id: marginRule.id },
    otherToken
  )

  check(
    "B cannot run A's rule",
    !rivalRun.ok,
    `status ${rivalRun.status} -- a DEFINER function must check membership itself`
  )

  const rivalBusinessRun = await tryRpc(
    "automation_evaluate_business",
    { p_business_id: businessId },
    otherToken
  )

  check(
    "B cannot run every rule in A's business",
    !rivalBusinessRun.ok,
    `status ${rivalBusinessRun.status}`
  )

  const rivalAck = await tryRpc(
    "alert_acknowledge",
    { p_alert_id: raised.id },
    otherToken
  )

  check("B cannot acknowledge A's alert", !rivalAck.ok)

  const rivalDelete = await attempt(
    `/rest/v1/automation_rules?id=eq.${marginRule.id}`,
    { method: "DELETE" },
    otherToken
  )

  const stillThere = await api(`/rest/v1/automation_rules?id=eq.${marginRule.id}`)

  check(
    "B cannot delete A's rule",
    stillThere.length === 1,
    `delete returned ${rivalDelete.status}`
  )

  /* ---------------------------------------------------------------------- */
  section("8. THE CROSS-TENANT CLAIM IS THE WORKER'S ALONE")

  const claimAsUser = await tryRpc("automation_claim_due", { p_limit: 5 })

  check(
    "a signed-in user cannot claim due rules",
    !claimAsUser.ok,
    `status ${claimAsUser.status} -- it reads every business's rules`
  )

  if (!HAS_SERVICE_KEY) {
    skip("the worker claims and evaluates", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("the worker never carries a business id", "same")
  } else {
    // Make one rule due immediately.
    await api(`/rest/v1/automation_rules?id=eq.${comfortableRule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ next_run_at: daysAgo(1) }),
    })

    const claimed = await serviceRpc("automation_claim_due", { p_limit: 50 })

    check(
      "the worker can claim due rules with no session at all",
      claimed.ok && Array.isArray(claimed.body),
      `status ${claimed.status}`
    )

    const claimedIds = (claimed.body ?? []).map((r: { rule_id: string }) => r.rule_id)

    check(
      "the due rule was among them",
      claimedIds.includes(comfortableRule.id)
    )

    const reclaimed = await serviceRpc("automation_claim_due", { p_limit: 50 })
    const reclaimedIds = (reclaimed.body ?? []).map((r: { rule_id: string }) => r.rule_id)

    check(
      "and claiming again does not hand back the same rule",
      !reclaimedIds.includes(comfortableRule.id),
      "two workers running at once would otherwise both evaluate it"
    )

    const workerRun = await serviceRpc("automation_evaluate_rule", {
      p_rule_id: comfortableRule.id,
    })

    check(
      "the worker can evaluate a rule with no session",
      workerRun.ok,
      `status ${workerRun.status}`
    )

    check(
      "and the run is attributed to the right business",
      workerRun.body?.business_id === businessId
    )

    const [sessionlessAudit] = await api(
      `/rest/v1/audit_logs?business_id=eq.${businessId}` +
        `&action=eq.automation.alert.raised&actor_id=is.null&limit=1`
    )

    check(
      "a sessionless alert is audited with a null actor, not a forged one",
      sessionlessAudit !== undefined || workerRun.body?.status !== "FIRED",
      "write_audit_log() refuses a null session, which is why this path " +
        "writes the entry itself"
    )
  }

  /* ---------------------------------------------------------------------- */
  section("9. THE STORED FIGURES ARE STILL EXACT TEXT")

  const [exactRun] = await api(`/rest/v1/automation_runs?id=eq.${fired.id}`)

  check(
    "a threshold comes back as a quoted string",
    typeof exactRun.threshold === "string",
    typeof exactRun.threshold
  )

  check(
    "a metric value comes back as a quoted string",
    typeof exactRun.metric_value === "string"
  )

  const [exactAlert] = await api(`/rest/v1/alerts?id=eq.${raised.id}`)

  check(
    "and so does everything on the alert",
    typeof exactAlert.metric_value === "string" &&
      typeof exactAlert.threshold === "string",
    "an unquoted JSON number would already have passed through a double"
  )
} finally {
  section("Cleanup")

  await attempt(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" })
  await attempt(`/rest/v1/businesses?id=eq.${rivalId}`, { method: "DELETE" }, otherToken)

  const gone = await api(`/rest/v1/automation_rules?business_id=eq.${businessId}`)
  console.log(
    `  removed both test tenants (${gone.length} rules remain, expected 0)`
  )
}

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
