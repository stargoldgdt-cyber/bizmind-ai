/**
 * Migration 0010: the live contract.
 *
 * Run with:  npm run test:migration-0010
 *
 * A migration that reported success is not the same as a contract that holds.
 * The DO block inside 0010 checks what it could see at install time, in one
 * transaction, as the owning role. This suite checks what a signed-in customer
 * actually gets: the columns, their types, their nullability, the arithmetic,
 * the isolation, and -- because these two figures exist for one specific
 * reason -- that they reach the AI fact sheet without anything in between
 * recomputing them.
 *
 * The path under test, end to end:
 *
 *   DATABASE -> ANALYTICS -> VERIFIED FACT SHEET -> AI NARRATION
 *
 * Everything runs in throwaway tenants that are deleted at the end.
 *
 * Credentials come from .env.test.local. Two sign-ins are required: proving
 * one business cannot read another's figures needs two people.
 */

import { requireConfig } from "./test-env.mjs"

import { buildFactSheet, renderFactSheet } from "../src/services/ai/facts"
import { buildAllowlist } from "../src/services/ai/guard"
import type { Financials } from "../src/services/analytics/types"

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

const {
  url: SUPABASE_URL,
  anonKey: ANON_KEY,
  email: EMAIL,
  password: PASSWORD,
  otherEmail: OTHER_EMAIL,
  otherPassword: OTHER_PASSWORD,
} = requireConfig({ second: true })

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

const rpc = (fn: string, args: unknown, asToken = token) =>
  api(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

/** The response body as TEXT, so the wire format can be inspected unparsed. */
async function rawFinancials(target: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/analytics_financials`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ p_business_id: target, p_from: FROM, p_to: TO }),
  })
  return response.text()
}

async function attemptRpc(fn: string, args: unknown, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Authorization: `Bearer ${asToken}`,
    },
    body: JSON.stringify(args),
  })
  return { ok: response.ok, status: response.status, body: await response.text() }
}

/* ---- Setup --------------------------------------------------------------- */

token = await signIn(EMAIL, PASSWORD)
const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)

section("Setup")
const suffix = Date.now().toString(36)

const business = await rpc("create_business", {
  p_name: `Gap Contract ${suffix}`,
  p_slug: `gap-contract-${suffix}`,
  p_currency: "AED",
})
const businessId = business.id as string

const rival = await rpc(
  "create_business",
  { p_name: `Gap Rival ${suffix}`, p_slug: `gap-rival-${suffix}`, p_currency: "AED" },
  otherToken
)
const rivalId = rival.id as string

console.log(`  tenant A: ${business.name}`)
console.log(`  tenant B: ${rival.name} (a different person)`)

const FROM = "2026-05-01T00:00:00Z"
const TO = "2026-06-01T00:00:00Z"

try {
  /* ---------------------------------------------------------------------- */
  section("1. THE MIGRATION IS APPLIED AND THE COLUMNS EXIST")

  async function seed(target: string, asToken: string) {
    const [batch] = await api(
      "/rest/v1/import_batches",
      {
        method: "POST",
        body: JSON.stringify({
          business_id: target,
          entity: "ORDERS",
          status: "DRAFT",
          source: "AMAZON",
          file_name: "gap.csv",
          file_type: "csv",
          file_size_bytes: 128,
          row_count: 4,
        }),
      },
      asToken
    )

    // Four orders. Two lines have a cost, two do not -> cost gap 50%.
    // Two orders record a fee, two do not      -> fee  gap 50%.
    const rows = [1, 2, 3, 4].map((n) => ({
      external_id: `GAP-${n}`,
      placed_at: `2026-05-0${n}T00:00:00Z`,
      status: "FULFILLED",
      currency: "AED",
      total: "1000.00",
      subtotal: null,
      discount_total: null,
      tax_total: null,
      shipping_total: null,
      fee_total: n <= 2 ? "50.00" : null,
      items: [
        {
          sku: `SKU-${n}`,
          name: `Item ${n}`,
          quantity: "1",
          unit_price: "1000.00",
          unit_cost: n <= 2 ? "400.00" : null,
          discount: null,
          tax: null,
          line_total: "1000.00",
        },
      ],
    }))

    return rpc("import_apply_orders", { p_batch_id: batch.id, p_rows: rows }, asToken)
  }

  await seed(businessId, token)

  const financials = await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
  })

  const [f] = financials as Financials[]

  check(
    "analytics_financials returns cost_gap -- migration 0010 is applied",
    Object.prototype.hasOwnProperty.call(f, "cost_gap"),
    Object.keys(f).join(", ").slice(0, 120)
  )
  check(
    "and fee_gap",
    Object.prototype.hasOwnProperty.call(f, "fee_gap")
  )

  /* ---------------------------------------------------------------------- */
  section("2. TYPE, SHAPE AND NULLABILITY")

  // THE CONTRACT THESE ASSERTIONS ONCE DESCRIBED HAS CHANGED, ON PURPOSE.
  //
  // When this suite was first written it found PostgREST emitting numerics as
  // UNQUOTED JSON numbers -- {"cost_gap":50.00} -- which `JSON.parse` narrowed
  // to IEEE-754 doubles. That is what prompted migration 0011.
  //
  // Since 0011 every money and ratio column is cast to `text` in SQL, while it
  // is still exact, so the gaps now arrive as quoted decimal strings. The
  // assertions below were inverted rather than deleted: the old expectation is
  // recorded in this comment so the change reads as a decision, not a drift.
  const wire = await rawFinancials(businessId)

  check(
    "the wire format carries the figure's full scale",
    /"cost_gap":"50\.\d{2}"/.test(wire),
    wire.slice(0, 120)
  )
  check(
    "and it is now a QUOTED string, so JSON.parse cannot narrow it",
    /"cost_gap":"/.test(wire) && !/"cost_gap":\d/.test(wire)
  )
  check(
    "so after JSON.parse it is still a string",
    typeof f.cost_gap === "string",
    typeof f.cost_gap
  )
  check(
    "while the counts beside it are still numbers",
    typeof f.items_total === "number" && typeof f.orders_count === "number"
  )

  check("cost_gap = 50", Number(f.cost_gap) === 50, String(f.cost_gap))
  check("fee_gap = 50", Number(f.fee_gap) === 50, String(f.fee_gap))

  // The gaps are computed columns of a function result, so they have no
  // DEFAULT and cannot be written to. Confirm there is no table column of
  // either name that an application could set by hand.
  const writable = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?select=cost_gap&limit=1`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } }
  )
  check(
    "cost_gap is DERIVED, not a stored column anything could write",
    writable.status === 400,
    String(writable.status)
  )

  /* ---------------------------------------------------------------------- */
  section("3. NULL WHERE THERE IS NOTHING TO MEASURE")

  // The distinction the whole product runs on. A period with no orders has an
  // UNKNOWN gap, not a gap of zero -- zero would read as "nothing is missing".
  const [empty] = await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: "2019-01-01T00:00:00Z",
    p_to: "2019-02-01T00:00:00Z",
  })

  check("with no orders, fee_gap is NULL, not 0", empty.fee_gap === null, String(empty.fee_gap))
  check("with no lines, cost_gap is NULL, not 0", empty.cost_gap === null, String(empty.cost_gap))
  check("and coverage is NULL for the same reason", empty.cost_coverage === null)

  /* ---------------------------------------------------------------------- */
  section("4. THE ARITHMETIC IS THE DATABASE'S, AND IT BALANCES")

  check(
    "coverage and gap account for every order line between them",
    Math.abs(Number(f.cost_coverage) + Number(f.cost_gap) - 100) < 0.01,
    `${f.cost_coverage} + ${f.cost_gap}`
  )
  check(
    "and for every order",
    Math.abs(Number(f.fee_coverage) + Number(f.fee_gap) - 100) < 0.01,
    `${f.fee_coverage} + ${f.fee_gap}`
  )
  check(
    "the gap agrees with the raw counts it is derived from",
    Number(f.cost_gap) ===
      ((f.items_total - f.items_with_cost) / f.items_total) * 100,
    `${f.items_total - f.items_with_cost}/${f.items_total}`
  )
  check(
    "and the fee gap agrees with the unknown-fee count",
    Number(f.fee_gap) === (f.orders_fees_unknown / f.orders_count) * 100,
    `${f.orders_fees_unknown}/${f.orders_count}`
  )

  /* ---------------------------------------------------------------------- */
  section("5. THE MIGRATION CHANGED NOTHING ELSE")

  // 0010 dropped and recreated analytics_financials. Everything that function
  // returned before must still be exactly what it returned before.
  check("revenue = 4000", Number(f.revenue) === 4000, String(f.revenue))
  check("cogs = 800, only the costed lines", Number(f.cogs) === 800, String(f.cogs))
  check("fees = 100, only the recorded ones", Number(f.fees) === 100, String(f.fees))
  check(
    "gross profit = 3100",
    Number(f.gross_profit) === 3100,
    String(f.gross_profit)
  )
  check("gross margin = 77.50", Number(f.gross_margin) === 77.5, String(f.gross_margin))
  check("orders = 4", f.orders_count === 4, String(f.orders_count))
  check("cost coverage = 50.00", Number(f.cost_coverage) === 50, String(f.cost_coverage))
  check("fee coverage = 50.00", Number(f.fee_coverage) === 50, String(f.fee_coverage))
  check(
    "orders with unknown fees still counted separately from zero-fee orders",
    f.orders_fees_unknown === 2 && f.orders_zero_fees === 0,
    `${f.orders_fees_unknown} / ${f.orders_zero_fees}`
  )

  // The dropped function's dependants must still work: dropping a function
  // discards its grants, and these call it.
  const reconciliation = await rpc("analytics_reconciliation", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
  })
  check("analytics_reconciliation still runs", Array.isArray(reconciliation))

  const health = await rpc("analytics_health_inputs", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
    p_prev_from: "2026-04-01T00:00:00Z",
    p_prev_to: FROM,
  })
  check("analytics_health_inputs still runs", Array.isArray(health))

  /* ---------------------------------------------------------------------- */
  section("6. SECURITY: THE FUNCTION IS EXECUTABLE, AND ONLY BY THE RIGHT PEOPLE")

  // Dropping a function discards its grants. An analytics engine nobody may
  // execute is a silent, total outage -- migration 0008 learned this the hard
  // way, so it is asserted from the outside here, not just inside the DDL.
  check("a signed-in member can execute it", Array.isArray(financials))

  const anonymous = await fetch(`${SUPABASE_URL}/rest/v1/rpc/analytics_financials`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_business_id: businessId, p_from: FROM, p_to: TO }),
  })
  check(
    "a signed-out visitor cannot execute it at all",
    anonymous.status === 401 || anonymous.status === 404,
    String(anonymous.status)
  )

  /* ---------------------------------------------------------------------- */
  section("7. TENANT ISOLATION OF THE NEW FIGURES")

  // B's own business has different data, so a leak would be visible as A's
  // numbers rather than as an error.
  await seed(rivalId, otherToken)

  const bAsksAboutA = await attemptRpc(
    "analytics_financials",
    { p_business_id: businessId, p_from: FROM, p_to: TO },
    otherToken
  )

  check(
    "B may call the function but learns nothing about A",
    bAsksAboutA.ok,
    String(bAsksAboutA.status)
  )

  const leaked = JSON.parse(bAsksAboutA.body)[0]
  check(
    "A's cost_gap does not leak to B -- it comes back NULL, not 50",
    leaked.cost_gap === null,
    String(leaked.cost_gap)
  )
  check("nor A's fee_gap", leaked.fee_gap === null, String(leaked.fee_gap))
  check("nor A's revenue", Number(leaked.revenue) === 0, String(leaked.revenue))
  check(
    "RLS returns an EMPTY result, never another tenant's figures",
    leaked.orders_count === 0,
    String(leaked.orders_count)
  )

  // And B's own figures are unaffected by any of it.
  const [bOwn] = await rpc(
    "analytics_financials",
    { p_business_id: rivalId, p_from: FROM, p_to: TO },
    otherToken
  )
  check("B still sees B's own gap figures", Number(bOwn.cost_gap) === 50, String(bOwn.cost_gap))

  /* ---------------------------------------------------------------------- */
  section("8. THE WHOLE PATH: DATABASE -> ANALYTICS -> FACT SHEET -> AI")

  // The reason these two columns exist. If the figure does not survive the
  // journey into the fact sheet, an explanation has to derive it again -- which
  // is the failure the migration was written to remove.
  const sheet = buildFactSheet({
    businessName: business.name,
    currency: "AED",
    periodLabel: "May 2026",
    comparisonLabel: "April 2026",
    scopeLabel: "the whole business",
  channelScoped: false,
  periodIncomplete: false,
    current: f,
    comparisons: [],
    channels: [],
    products: [],
    health: {
      score: null,
      status: "unknown",
      dimensionsScored: 0,
      dimensionsTotal: 6,
      dimensionsLowConfidence: 0,
      confidence: "low",
      confidenceNote: "Nothing could be measured yet.",
      summary: "Not enough data.",
      dimensions: [],
    },
    insights: [],
  })

  const sheetText = renderFactSheet(sheet)

  check(
    "the DATABASE's cost gap reaches the fact sheet verbatim",
    sheetText.includes("Share of order lines with NO recorded cost: 50.0%"),
    sheetText.split("\n").find((l) => l.includes("NO recorded cost")) ?? "(absent)"
  )
  check(
    "and the fee gap",
    sheetText.includes("Share of orders with NO recorded fee: 50.0%")
  )

  check(
    "the AI is therefore ALLOWED to quote the gap without deriving it",
    buildAllowlist(sheetText).has("50")
  )

  // The point of the whole exercise, stated as an assertion: the figure the
  // model needs is one BizMind computed, so it never has to do arithmetic.
  const gapFact = sheet.quality.find((fact) => fact.key === "cost_gap")
  check("the gap is a first-class fact, with its own definition", gapFact !== undefined)
  check(
    "and it is the value SQL produced, not one TypeScript worked out",
    gapFact?.display === "50.0%",
    gapFact?.display
  )

  // Proof by absence: no source file outside SQL derives this figure.
  const { readFileSync, readdirSync, statSync } = await import("node:fs")
  const { join } = await import("node:path")

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full)
    }
    return out
  }

  const derives = walk("src").filter((file) => {
    const contents = readFileSync(file, "utf8")
    return /100\s*-\s*[A-Za-z_.]*(coverage)/.test(contents)
  })
  check(
    "NOTHING in TypeScript computes the gap as 100 minus coverage",
    derives.length === 0,
    derives.join(", ")
  )
} finally {
  section("Cleanup")
  await api(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" })
  await api(`/rest/v1/businesses?id=eq.${rivalId}`, { method: "DELETE" }, otherToken)

  const goneA = await api(`/rest/v1/businesses?select=id&id=eq.${businessId}`)
  const goneB = await api(`/rest/v1/businesses?select=id&id=eq.${rivalId}`, {}, otherToken)
  check("both throwaway tenants deleted", goneA.length === 0 && goneB.length === 0)
}

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
