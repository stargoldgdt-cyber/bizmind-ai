/**
 * The money boundary, against the live database.
 *
 * Run with:  npm run test:money-boundary
 *
 * One question, asked of the real system: does an exact decimal held in
 * PostgreSQL still have every one of its digits by the time it reaches the AI
 * fact sheet?
 *
 * The whole path is exercised:
 *
 *   PostgreSQL numeric(20,4)
 *     -> PostgREST
 *       -> JSON.parse
 *         -> analytics service
 *           -> fact sheet
 *             -> the numbers the AI is permitted to quote
 *
 * The test value is chosen to fail loudly if anything converts it on the way.
 * 9007199254740993 is 2 to the 53rd plus one: the smallest integer a double
 * cannot represent. `Number("9007199254740993")` returns 9007199254740992. If
 * any step parses this figure as a number, the last digit is gone and this
 * suite says so.
 *
 * Runs in throwaway tenants, deleted at the end.
 */

import { requireConfig } from "./test-env.mjs"

import { buildFactSheet, renderFactSheet } from "../src/services/ai/facts"
import { buildAllowlist } from "../src/services/ai/guard"
import { compareMoney } from "../src/services/analytics/money"
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

/* ---- The value that exposes a lossy boundary ----------------------------- */

/** 2^53 + 1. The smallest integer an IEEE-754 double cannot hold. */
const EXACT_TOTAL = "9007199254740993.0000"

/** What `Number()` would turn that into. Asserted, not assumed. */
const LOSSY_TOTAL = "9007199254740992"

/** A value whose trailing digits vanish under any numeric round trip. */
const EXACT_FEE = "0.1000"

/* ---- REST helpers -------------------------------------------------------- */

let token = ""

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

/** The raw, unparsed response, so the wire format itself can be inspected. */
async function rawRpc(fn: string, args: unknown, asToken = token): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Authorization: `Bearer ${asToken}`,
    },
    body: JSON.stringify(args),
  })
  return response.text()
}

/* ---- Setup --------------------------------------------------------------- */

token = await signIn(EMAIL, PASSWORD)
const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)

section("Setup")
const suffix = Date.now().toString(36)

const business = await rpc("create_business", {
  p_name: `Money Boundary ${suffix}`,
  p_slug: `money-boundary-${suffix}`,
  p_currency: "AED",
})
const businessId = business.id as string

const rival = await rpc(
  "create_business",
  { p_name: `Money Rival ${suffix}`, p_slug: `money-rival-${suffix}`, p_currency: "AED" },
  otherToken
)
const rivalId = rival.id as string

console.log(`  tenant A: ${business.name}`)
console.log(`  tenant B: ${rival.name} (a different person)`)
console.log(`  test value: ${EXACT_TOTAL}  (2^53 + 1, unrepresentable as a double)`)

const FROM = "2026-07-01T00:00:00Z"
const TO = "2026-08-01T00:00:00Z"

try {
  /* ---------------------------------------------------------------------- */
  section("0. The premise: this value really does break a double")

  check(
    "Number() loses the last digit of the test value",
    String(Number(EXACT_TOTAL.split(".")[0])) === LOSSY_TOTAL,
    String(Number(EXACT_TOTAL.split(".")[0]))
  )
  check(
    "so any step that parses it as a number is detectable",
    Number("9007199254740993") === Number("9007199254740992")
  )

  /* ---------------------------------------------------------------------- */
  section("1. Store it, exactly, in PostgreSQL")

  const [batch] = await api("/rest/v1/import_batches", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      entity: "ORDERS",
      status: "DRAFT",
      source: "AMAZON",
      file_name: "boundary.csv",
      file_type: "csv",
      file_size_bytes: 64,
      row_count: 2,
    }),
  })

  await rpc("import_apply_orders", {
    p_batch_id: batch.id,
    p_rows: [
      {
        // The precision-sensitive order.
        external_id: "EXACT-1",
        placed_at: "2026-07-01T00:00:00Z",
        status: "FULFILLED",
        currency: "AED",
        total: EXACT_TOTAL,
        subtotal: null,
        discount_total: null,
        tax_total: null,
        shipping_total: null,
        fee_total: EXACT_FEE,
        items: [
          {
            sku: "EXACT",
            name: "Exact",
            quantity: "1",
            unit_price: EXACT_TOTAL,
            unit_cost: "0.0000",
            discount: null,
            tax: null,
            line_total: EXACT_TOTAL,
          },
        ],
      },
      {
        // An order recording an EXPLICIT ZERO fee, and no cost at all. The two
        // must stay distinguishable all the way through.
        external_id: "ZERO-1",
        placed_at: "2026-07-02T00:00:00Z",
        status: "FULFILLED",
        currency: "AED",
        total: "0.0000",
        subtotal: null,
        discount_total: null,
        tax_total: null,
        shipping_total: null,
        fee_total: "0.0000",
        items: [
          {
            sku: "ZERO",
            name: "Zero",
            quantity: "1",
            unit_price: "0.0000",
            unit_cost: null,
            discount: null,
            tax: null,
            line_total: "0.0000",
          },
        ],
      },
    ],
  })

  const stored = await api(
    `/rest/v1/orders?select=external_id,total,fee_total&business_id=eq.${businessId}&order=external_id.asc`
  )
  const exactRow = stored.find((o: { external_id: string }) => o.external_id === "EXACT-1")
  const zeroRow = stored.find((o: { external_id: string }) => o.external_id === "ZERO-1")

  check("the order was written", exactRow !== undefined)
  check(
    "an explicit zero fee is stored as zero, not as unknown",
    zeroRow.fee_total !== null && Number(zeroRow.fee_total) === 0,
    String(zeroRow.fee_total)
  )

  /* ---------------------------------------------------------------------- */
  section("2. THE WIRE: what PostgREST actually sends")

  const wire = await rawRpc("analytics_financials", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
  })

  check(
    "revenue is sent as a QUOTED string, not a bare JSON number",
    wire.includes(`"revenue":"${EXACT_TOTAL}"`),
    wire.slice(0, 160)
  )
  check(
    "and no money field is sent unquoted any more",
    !/"(revenue|cogs|fees|gross_profit|net_profit|expenses|refunds)":-?\d/.test(wire),
    (wire.match(/"(revenue|cogs|fees|gross_profit)":[^,"]+/) ?? ["(none)"])[0]
  )
  check(
    "counts are still sent as numbers, because they are exact integers",
    /"orders_count":\d/.test(wire)
  )
  check(
    "an uncalculable figure is sent as JSON null, not as a string",
    !/"(cost_coverage|fee_coverage)":""/.test(wire)
  )

  /* ---------------------------------------------------------------------- */
  section("3. AFTER JSON.parse: the runtime type matches the declared type")

  const [f] = (await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
  })) as Financials[]

  const MONEY_KEYS: (keyof Financials)[] = [
    "revenue", "cogs", "fees", "gross_profit", "expenses", "net_profit",
    "refunds", "line_revenue", "units_sold",
  ]

  for (const key of MONEY_KEYS) {
    check(
      `${String(key)} is a string at runtime, as declared`,
      typeof f[key] === "string",
      `${typeof f[key]}: ${JSON.stringify(f[key])}`
    )
  }

  const COUNT_KEYS: (keyof Financials)[] = [
    "orders_count", "customers_count", "items_total", "items_with_cost",
  ]
  for (const key of COUNT_KEYS) {
    check(
      `${String(key)} is still a number, as declared`,
      typeof f[key] === "number",
      typeof f[key]
    )
  }

  /* ---------------------------------------------------------------------- */
  section("4. PRECISION: every digit survived")

  check(
    `revenue is exactly ${EXACT_TOTAL}`,
    f.revenue === EXACT_TOTAL,
    JSON.stringify(f.revenue)
  )
  check(
    "including the digit a double would have dropped",
    f.revenue.startsWith("9007199254740993"),
    f.revenue
  )
  check(
    "PROOF: converting it now WOULD lose that digit",
    String(Number(f.revenue)).startsWith(LOSSY_TOTAL) &&
      String(Number(f.revenue)) !== f.revenue,
    `Number(revenue) = ${Number(f.revenue)}`
  )
  check(
    "the fee kept its trailing zeros -- 0.1000, not 0.1",
    f.fees === "0.1000",
    JSON.stringify(f.fees)
  )
  // PostgreSQL keeps the natural scale of each operation -- a product of two
  // 4-decimal numerics has 8 -- so the value is compared, not the formatting.
  check(
    "gross profit was calculated in SQL from the exact figure",
    compareMoney(f.gross_profit, "9007199254740992.9") === 0,
    JSON.stringify(f.gross_profit)
  )
  check(
    "and it kept its decimal places rather than being truncated",
    f.gross_profit.includes("."),
    f.gross_profit
  )
  check(
    "and the exact comparator can still order it against its neighbour",
    compareMoney(f.revenue, "9007199254740992.0000") > 0
  )

  /* ---------------------------------------------------------------------- */
  section("5. NULL stays unknown, zero stays zero")

  check(
    "an order line with no cost leaves cost coverage below 100",
    f.cost_coverage === "50.00",
    JSON.stringify(f.cost_coverage)
  )
  check(
    "the explicitly zero fee is counted as recorded, not unknown",
    f.orders_fees_unknown === 0 && f.orders_zero_fees === 1,
    `unknown ${f.orders_fees_unknown}, zero ${f.orders_zero_fees}`
  )
  check("fee coverage is therefore 100", f.fee_coverage === "100.00", String(f.fee_coverage))

  const [empty] = (await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: "2019-01-01T00:00:00Z",
    p_to: "2019-02-01T00:00:00Z",
  })) as Financials[]

  check("with nothing to measure, cost coverage is NULL", empty.cost_coverage === null)
  check("not the string \"0\"", empty.cost_coverage !== "0")
  check("not an empty string", empty.cost_coverage !== "")
  check("and revenue is an exact zero, not null", empty.revenue === "0")
  check("refund rate is NULL when there is no revenue", empty.refund_rate === null)

  /* ---------------------------------------------------------------------- */
  section("6. EVERY analytics function returns money as text")

  const channels = await rpc("analytics_channels", {
    p_business_id: businessId, p_from: FROM, p_to: TO,
  })
  check(
    "analytics_channels revenue is text",
    channels.length === 0 || typeof channels[0].revenue === "string",
    channels.length === 0 ? "(no channels)" : typeof channels[0].revenue
  )

  const products = await rpc("analytics_products", {
    p_business_id: businessId, p_from: FROM, p_to: TO, p_limit: 10,
  })
  check(
    "analytics_products revenue and fees_allocated are text",
    products.length > 0 &&
      typeof products[0].revenue === "string" &&
      typeof products[0].fees_allocated === "string",
    products.length === 0 ? "(no products)" : typeof products[0].revenue
  )
  check(
    "and a product's revenue kept full precision",
    products.some((p: { revenue: string }) => p.revenue === EXACT_TOTAL),
    products.map((p: { revenue: string }) => p.revenue).join(", ")
  )

  const compare = await rpc("analytics_compare", {
    p_business_id: businessId, p_from: FROM, p_to: TO,
    p_prev_from: "2026-06-01T00:00:00Z", p_prev_to: FROM,
  })
  const revenueRow = compare.find((c: { metric: string }) => c.metric === "revenue")
  check("analytics_compare values are text", typeof revenueRow.current_value === "string")
  check(
    "and the compared figure is the exact one",
    revenueRow.current_value === EXACT_TOTAL,
    revenueRow.current_value
  )

  const [rec] = await rpc("analytics_reconciliation", {
    p_business_id: businessId, p_from: FROM, p_to: TO,
  })
  check("analytics_reconciliation figures are text", typeof rec.order_revenue === "string")
  check(
    "and reconciliation is exact at 2^53+1, where a double would drift",
    rec.order_revenue === EXACT_TOTAL,
    rec.order_revenue
  )

  const [health] = await rpc("analytics_health_inputs", {
    p_business_id: businessId, p_from: FROM, p_to: TO,
    p_prev_from: "2026-06-01T00:00:00Z", p_prev_to: FROM,
  })
  check("analytics_health_inputs figures are text", typeof health.revenue === "string")
  check("with the exact value", health.revenue === EXACT_TOTAL, health.revenue)
  check(
    "and its counts are still numbers",
    typeof health.orders_count === "number",
    typeof health.orders_count
  )

  /* ---------------------------------------------------------------------- */
  section("7. INTO THE AI FACT SHEET, unchanged")

  const sheet = buildFactSheet({
    businessName: business.name,
    currency: "AED",
    periodLabel: "July 2026",
    comparisonLabel: "June 2026",
    periodIncomplete: false,
    current: f,
    comparisons: [],
    channels: [],
    products: [],
    health: {
      score: null, status: "unknown", dimensionsScored: 0, dimensionsTotal: 6,
      summary: "Not enough data.", dimensions: [],
    },
    insights: [],
  })

  const sheetText = renderFactSheet(sheet)
  const revenueFact = sheet.headline.find((fact) => fact.key === "revenue")

  check("the fact sheet carries a revenue figure", revenueFact !== undefined)
  check(
    "formatted for a human, and still the same number underneath",
    revenueFact?.display.includes("9,007,199,254,740,993") === true,
    revenueFact?.display
  )
  // Note the ".00": 9,007,199,254,740,992 on its own is a legitimate substring
  // of gross profit, which really is ...992.90. What must not appear is the
  // LOSSY RENDERING OF REVENUE, which is that figure with two zero decimals.
  check(
    "the sheet never shows the value a double would have produced for revenue",
    !sheetText.includes("9,007,199,254,740,992.00"),
    sheetText.split(/\n/).find((l) => l.includes("9,007,199,254,740,992.00")) ?? ""
  )
  check(
    "gross profit is shown exactly too, decimals and all",
    sheetText.includes("9,007,199,254,740,992.90"),
    sheetText.split(/\n/).find((l) => l.includes("Gross profit")) ?? "(absent)"
  )

  // The guard's allowlist is built from the sheet, so the AI may quote the
  // exact figure and nothing else.
  const allowed = buildAllowlist(sheetText)
  check(
    "the AI is permitted to quote the exact figure",
    allowed.has("9007199254740993"),
  )

  /* ---------------------------------------------------------------------- */
  section("8. ANALYTICS RESULTS ARE UNCHANGED BY THE BOUNDARY")

  // The same seeded data, in a second tenant, checked against figures computed
  // before this migration existed. Values must be identical; only their type
  // changed.
  const [batchB] = await api(
    "/rest/v1/import_batches",
    {
      method: "POST",
      body: JSON.stringify({
        business_id: rivalId, entity: "ORDERS", status: "DRAFT", source: "AMAZON",
        file_name: "b.csv", file_type: "csv", file_size_bytes: 64, row_count: 2,
      }),
    },
    otherToken
  )

  await rpc(
    "import_apply_orders",
    {
      p_batch_id: batchB.id,
      p_rows: [1, 2].map((n) => ({
        external_id: `B-${n}`,
        placed_at: `2026-07-0${n}T00:00:00Z`,
        status: "FULFILLED",
        currency: "AED",
        total: "1000.00",
        subtotal: null, discount_total: null, tax_total: null, shipping_total: null,
        fee_total: "50.00",
        items: [{
          sku: `B-${n}`, name: `B ${n}`, quantity: "2",
          unit_price: "500.00", unit_cost: "200.00",
          discount: null, tax: null, line_total: "1000.00",
        }],
      })),
    },
    otherToken
  )

  const [b] = (await rpc(
    "analytics_financials",
    { p_business_id: rivalId, p_from: FROM, p_to: TO },
    otherToken
  )) as Financials[]

  check("revenue = 2000", compareMoney(b.revenue, "2000") === 0, b.revenue)
  check("cogs = 800", compareMoney(b.cogs, "800") === 0, b.cogs)
  check("fees = 100", compareMoney(b.fees, "100") === 0, b.fees)
  check(
    "gross profit = 1100",
    compareMoney(b.gross_profit, "1100") === 0,
    b.gross_profit
  )
  check(
    "every one of them arrived as exact decimal text",
    [b.revenue, b.cogs, b.fees, b.gross_profit].every((v) => typeof v === "string")
  )
  check("gross margin = 55.00", b.gross_margin === "55.00", String(b.gross_margin))
  check("average order value = 1000.00", b.avg_order_value === "1000.00", String(b.avg_order_value))
  check("cost coverage = 100.00", b.cost_coverage === "100.00", String(b.cost_coverage))
  check("orders = 2, still an integer", b.orders_count === 2)

  /* ---------------------------------------------------------------------- */
  section("9. TENANT ISOLATION IS UNAFFECTED")

  const leak = (await rpc(
    "analytics_financials",
    { p_business_id: businessId, p_from: FROM, p_to: TO },
    otherToken
  )) as Financials[]

  check(
    "B asking about A's business gets zeros, not A's figures",
    leak[0].revenue === "0" && leak[0].orders_count === 0,
    leak[0].revenue
  )
  check(
    "and certainly not the precision-sensitive one",
    leak[0].revenue !== EXACT_TOTAL
  )

  const anonymous = await fetch(`${SUPABASE_URL}/rest/v1/rpc/analytics_financials`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_business_id: businessId, p_from: FROM, p_to: TO }),
  })
  check("a signed-out visitor is refused", anonymous.status === 401 || anonymous.status === 404)

  // The exact-numeric implementations live in a schema PostgREST does not
  // expose, so there is only ONE money representation reachable over the API.
  const privateSchema = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/analytics_financials?select=*`,
    {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        "Content-Type": "application/json",
        "Accept-Profile": "analytics_core",
        "Content-Profile": "analytics_core",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ p_business_id: businessId, p_from: FROM, p_to: TO }),
    }
  )
  check(
    "the numeric implementations are NOT reachable over the API",
    privateSchema.status >= 400,
    String(privateSchema.status)
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
