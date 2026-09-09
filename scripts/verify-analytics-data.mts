/**
 * Analytics verified against a realistic commerce dataset.
 *
 * Run with:  npm run test:analytics-data
 *
 * A deliberately shaped two-channel business is built in a throwaway tenant,
 * every expected figure is worked out by hand in the comments below, and the
 * engine is held to those numbers exactly. Reconciliation and tenant isolation
 * are asserted here too, because both are properties of the whole system
 * rather than of any single function.
 *
 * Credentials come from the environment:
 *   BIZMIND_TEST_EMAIL, BIZMIND_TEST_PASSWORD
 */

import { requireConfig } from "./test-env.mjs"

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

/** Compares an exact decimal by value, so 1830 and "1830.00000000" match. */
function eq(actual: unknown, expected: number): boolean {
  return actual !== null && actual !== undefined && Number(actual) === expected
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

/* ---- Configuration ------------------------------------------------------- */

const {
  url: SUPABASE_URL,
  anonKey: ANON_KEY,
  email: EMAIL,
  password: PASSWORD,
  otherEmail: OTHER_EMAIL,
  otherPassword: OTHER_PASSWORD,
} = requireConfig()

/* ---- REST helper --------------------------------------------------------- */

let token = ""

async function api(path: string, init: RequestInit = {}, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(asToken ? { Authorization: `Bearer ${asToken}` } : {}),
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

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(`Could not sign in as ${email}`)
  return (await response.json()).access_token
}

/* ==========================================================================
 * THE DATASET, AND THE NUMBERS IT MUST PRODUCE
 * ==========================================================================
 *
 * Window: 2026-05-01 to 2026-06-01. Previous: 2026-04-01 to 2026-05-01.
 *
 * Products      cost   price
 *   SHIRT        300     800
 *   SCARF        150     500
 *   BAG          900    2000
 *
 * Current-period orders
 *   AMZ-1  Amazon   2 x SHIRT   line 1600  total 1600  fee 160   cost 600
 *   AMZ-2  Amazon   1 x BAG     line 2000  total 2100  fee 210   cost 900
 *                                          (+100 shipping)
 *   WEB-1  Website  3 x SCARF   line 1500  total 1500  fee   0   cost 450
 *   WEB-2  Website  1 x SHIRT   line  800              fee   0   cost 300
 *                   1 x SCARF   line  500  total 1300            cost 150
 *   AMZ-3  Amazon   CANCELLED -- excluded from every figure
 *
 * Previous-period order
 *   PREV-1 Website  1 x SHIRT   line  800  total  800  fee   0   cost 300
 *
 * Expenses: 1200 in the current period, none in the previous.
 *
 * HAND-CALCULATED EXPECTATIONS
 *   revenue        1600 + 2100 + 1500 + 1300      = 6500
 *   fees            160 +  210 +    0 +    0      =  370
 *   cogs            600 +  900 +  450 +  450      = 2400
 *   gross_profit   6500 - 2400 - 370              = 3730
 *   gross_margin   3730 / 6500 * 100              = 57.38
 *   expenses                                        1200
 *   net_profit     3730 - 1200                    = 2530
 *   net_margin     2530 / 6500 * 100              = 38.92
 *   orders                                           4
 *   units          2 + 1 + 3 + 2                  =    8
 *   aov            6500 / 4                       = 1625
 *   line_revenue   1600 + 2000 + 1500 + 1300      = 6400
 *   order_line_gap 6500 - 6400                    =  100  (the shipping)
 *   items 5, all costed                           -> coverage 100
 *
 *   Amazon   revenue 3700  cogs 1500  fees 370  profit 1830  margin 49.46
 *   Website  revenue 2800  cogs  900  fees   0  profit 1900  margin 67.86
 *   -> Amazon earns MORE revenue but LESS profit. The product's whole point.
 *
 *   SHIRT  revenue 2400  units 3  cogs 900  fees 160  profit 1340  margin 55.83
 *   SCARF  revenue 2000  units 4  cogs 600  fees   0  profit 1400  margin 70.00
 *   BAG    revenue 2000  units 1  cogs 900  fees 210  profit  890  margin 44.50
 *
 *   revenue vs previous: 6500 vs 800  -> +5700, +712.5%
 *   profit  vs previous: 3730 vs 500  -> +3230, +646%
 * ========================================================================== */

const FROM = "2026-05-01T00:00:00Z"
const TO = "2026-06-01T00:00:00Z"
const PREV_FROM = "2026-04-01T00:00:00Z"
const PREV_TO = "2026-05-01T00:00:00Z"

let businessId = ""

section("Setup -- building a two-channel business in a throwaway tenant")

token = await signIn(EMAIL, PASSWORD)

const suffix = Date.now().toString(36)
const business = await rpc("create_business", {
  p_name: `Analytics Verify ${suffix}`,
  p_slug: `analytics-verify-${suffix}`,
  p_currency: "BDT",
})
businessId = business.id
console.log(`  tenant: ${business.name}`)

try {
  const [amazon] = await api("/rest/v1/channels", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId, name: "Amazon", type: "AMAZON" }),
  })
  const [website] = await api("/rest/v1/channels", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId, name: "Website", type: "WEBSITE" }),
  })

  const [custA] = await api("/rest/v1/customers", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId, email: "a@verify.test", full_name: "Buyer A" }),
  })
  const [custB] = await api("/rest/v1/customers", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId, email: "b@verify.test", full_name: "Buyer B" }),
  })
  const [custC] = await api("/rest/v1/customers", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId, email: "c@verify.test", full_name: "Buyer C" }),
  })

  async function order(
    number: string,
    channelId: string,
    customerId: string | null,
    placedAt: string,
    total: number,
    fee: number,
    status: string,
    lines: { sku: string; name: string; qty: number; price: number; cost: number | null }[]
  ) {
    const [row] = await api("/rest/v1/orders", {
      method: "POST",
      body: JSON.stringify({
        business_id: businessId,
        channel_id: channelId,
        customer_id: customerId,
        order_number: number,
        status,
        currency: "BDT",
        subtotal: String(lines.reduce((s, l) => s + l.qty * l.price, 0)),
        fee_total: String(fee),
        total: String(total),
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
          name: line.name,
          quantity: String(line.qty),
          unit_price: String(line.price),
          unit_cost: line.cost === null ? null : String(line.cost),
          line_total: String(line.qty * line.price),
        }),
      })
    }
    return row.id as string
  }

  await order("AMZ-1", amazon.id, custA.id, "2026-05-05T10:00:00Z", 1600, 160, "FULFILLED", [
    { sku: "SHIRT", name: "Cotton Shirt", qty: 2, price: 800, cost: 300 },
  ])
  await order("AMZ-2", amazon.id, custB.id, "2026-05-10T10:00:00Z", 2100, 210, "FULFILLED", [
    { sku: "BAG", name: "Leather Bag", qty: 1, price: 2000, cost: 900 },
  ])
  await order("WEB-1", website.id, custA.id, "2026-05-15T10:00:00Z", 1500, 0, "FULFILLED", [
    { sku: "SCARF", name: "Silk Scarf", qty: 3, price: 500, cost: 150 },
  ])
  await order("WEB-2", website.id, custC.id, "2026-05-20T10:00:00Z", 1300, 0, "FULFILLED", [
    { sku: "SHIRT", name: "Cotton Shirt", qty: 1, price: 800, cost: 300 },
    { sku: "SCARF", name: "Silk Scarf", qty: 1, price: 500, cost: 150 },
  ])
  // Cancelled: must be excluded from every figure, including its 200 in fees.
  await order("AMZ-3", amazon.id, custB.id, "2026-05-25T10:00:00Z", 2000, 200, "CANCELLED", [
    { sku: "BAG", name: "Leather Bag", qty: 1, price: 2000, cost: 900 },
  ])
  await order("PREV-1", website.id, custA.id, "2026-04-15T10:00:00Z", 800, 0, "FULFILLED", [
    { sku: "SHIRT", name: "Cotton Shirt", qty: 1, price: 800, cost: 300 },
  ])

  await api("/rest/v1/expenses", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      category: "Marketing",
      amount: "1200",
      currency: "BDT",
      incurred_at: "2026-05-18T00:00:00Z",
    }),
  })

  console.log("  6 orders (1 cancelled), 3 customers, 2 channels, 1 expense")

  /* ---------------------------------------------------------------------- */
  section("1. HEADLINE FIGURES -- every one checked against hand arithmetic")

  const [f] = await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
  })

  check("revenue = 6500", eq(f.revenue, 6500), String(f.revenue))
  check("fees = 370 (cancelled order's 200 excluded)", eq(f.fees, 370), String(f.fees))
  check("cogs = 2400", eq(f.cogs, 2400), String(f.cogs))
  check("gross profit = 3730", eq(f.gross_profit, 3730), String(f.gross_profit))
  check("gross margin = 57.38", eq(f.gross_margin, 57.38), String(f.gross_margin))
  check("expenses = 1200", eq(f.expenses, 1200), String(f.expenses))
  check("net profit = 2530", eq(f.net_profit, 2530), String(f.net_profit))
  check("net margin = 38.92", eq(f.net_margin, 38.92), String(f.net_margin))
  check("orders = 4 (cancelled excluded)", f.orders_count === 4, String(f.orders_count))
  check("units sold = 8", eq(f.units_sold, 8), String(f.units_sold))
  check("average order value = 1625", eq(f.avg_order_value, 1625), String(f.avg_order_value))
  check("customers = 3", f.customers_count === 3, String(f.customers_count))
  check("cancelled orders counted separately = 1", f.cancelled_orders === 1, String(f.cancelled_orders))
  check("line revenue = 6400", eq(f.line_revenue, 6400), String(f.line_revenue))
  check("5 order lines, all costed", f.items_total === 5 && f.items_with_cost === 5)
  check("cost coverage = 100", eq(f.cost_coverage, 100), String(f.cost_coverage))
  check("orders without a channel = 0", f.orders_without_channel === 0)

  // The gaps exist as their own SQL-computed figures so nothing downstream --
  // the AI layer above all -- ever has to derive one number from another.
  check("cost gap = 0, every line is costed", eq(f.cost_gap, 0), String(f.cost_gap))
  check(
    "coverage and gap account for every order line between them",
    Math.abs(Number(f.cost_coverage) + Number(f.cost_gap) - 100) < 0.01,
    `${f.cost_coverage} + ${f.cost_gap}`
  )
  check(
    "the same holds for fees",
    Math.abs(Number(f.fee_coverage) + Number(f.fee_gap) - 100) < 0.01,
    `${f.fee_coverage} + ${f.fee_gap}`
  )
  check(
    "each gap is computed by SQL, not returned as text the app must parse",
    f.cost_gap !== undefined && f.fee_gap !== undefined
  )

  /* ---------------------------------------------------------------------- */
  section("2. CHANNELS -- and the comparison the product exists to make")

  const channels = await rpc("analytics_channels", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
  })

  const amz = channels.find((c: { channel_name: string }) => c.channel_name === "Amazon")
  const web = channels.find((c: { channel_name: string }) => c.channel_name === "Website")

  check("Amazon revenue = 3700", eq(amz.revenue, 3700), String(amz.revenue))
  check("Amazon cogs = 1500", eq(amz.cogs, 1500), String(amz.cogs))
  check("Amazon fees = 370", eq(amz.fees, 370), String(amz.fees))
  check("Amazon gross profit = 1830", eq(amz.gross_profit, 1830), String(amz.gross_profit))
  check("Amazon margin = 49.46", eq(amz.gross_margin, 49.46), String(amz.gross_margin))
  check("Amazon AOV = 1850", eq(amz.avg_order_value, 1850), String(amz.avg_order_value))

  check("Website revenue = 2800", eq(web.revenue, 2800), String(web.revenue))
  check("Website cogs = 900", eq(web.cogs, 900), String(web.cogs))
  check("Website fees = 0", eq(web.fees, 0), String(web.fees))
  check("Website gross profit = 1900", eq(web.gross_profit, 1900), String(web.gross_profit))
  check("Website margin = 67.86", eq(web.gross_margin, 67.86), String(web.gross_margin))

  check(
    "THE USP: Amazon has more revenue but LESS profit than the website",
    Number(amz.revenue) > Number(web.revenue) && Number(amz.gross_profit) < Number(web.gross_profit)
  )

  /* ---------------------------------------------------------------------- */
  section("3. RECONCILIATION -- channels must sum to the total, exactly")

  const [rec] = await rpc("analytics_reconciliation", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
  })

  const channelSum = channels.reduce(
    (total: number, c: { revenue: string }) => total + Number(c.revenue),
    0
  )
  check("channel revenues sum to 6500", channelSum === 6500, String(channelSum))
  check(
    "reported channel difference is exactly zero",
    eq(rec.channel_difference, 0),
    String(rec.channel_difference)
  )
  check(
    "order revenue exceeds line revenue by exactly the 100 shipping",
    eq(rec.order_line_gap, 100),
    String(rec.order_line_gap)
  )
  check("no orders are missing lines", rec.orders_without_lines === 0)

  /* ---------------------------------------------------------------------- */
  section("4. PRODUCTS")

  const products = await rpc("analytics_products", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
    p_limit: 50,
  })

  const shirt = products.find((p: { sku: string }) => p.sku === "SHIRT")
  const scarf = products.find((p: { sku: string }) => p.sku === "SCARF")
  const bag = products.find((p: { sku: string }) => p.sku === "BAG")

  check("SHIRT revenue = 2400", eq(shirt.revenue, 2400), String(shirt.revenue))
  check("SHIRT units = 3", eq(shirt.units_sold, 3), String(shirt.units_sold))
  check("SHIRT cogs = 900", eq(shirt.cogs, 900), String(shirt.cogs))
  check("SHIRT allocated fees = 160", eq(shirt.fees_allocated, 160), String(shirt.fees_allocated))
  check("SHIRT gross profit = 1340", eq(shirt.gross_profit, 1340), String(shirt.gross_profit))
  check("SHIRT margin = 55.83", eq(shirt.gross_margin, 55.83), String(shirt.gross_margin))

  check("SCARF revenue = 2000", eq(scarf.revenue, 2000), String(scarf.revenue))
  check("SCARF units = 4", eq(scarf.units_sold, 4), String(scarf.units_sold))
  check("SCARF margin = 70.00", eq(scarf.gross_margin, 70), String(scarf.gross_margin))

  check("BAG revenue = 2000", eq(bag.revenue, 2000), String(bag.revenue))
  check("BAG allocated fees = 210", eq(bag.fees_allocated, 210), String(bag.fees_allocated))
  check("BAG margin = 44.50", eq(bag.gross_margin, 44.5), String(bag.gross_margin))

  const productSum = products.reduce(
    (total: number, p: { revenue: string }) => total + Number(p.revenue),
    0
  )
  check("product revenues sum to LINE revenue, 6400", productSum === 6400, String(productSum))
  const feeSum = products.reduce(
    (total: number, p: { fees_allocated: string }) => total + Number(p.fees_allocated),
    0
  )
  check("allocated fees sum back to the 370 actually charged", feeSum === 370, String(feeSum))

  /* ---------------------------------------------------------------------- */
  section("5. PERIOD COMPARISON")

  const comparisons = await rpc("analytics_compare", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
    p_prev_from: PREV_FROM,
    p_prev_to: PREV_TO,
  })

  const byMetric = new Map(comparisons.map((c: { metric: string }) => [c.metric, c]))
  const revenue = byMetric.get("revenue") as Record<string, unknown>
  const profit = byMetric.get("gross_profit") as Record<string, unknown>

  check("revenue current 6500", eq(revenue.current_value, 6500))
  check("revenue previous 800", eq(revenue.previous_value, 800))
  check("absolute change 5700", eq(revenue.absolute_change, 5700), String(revenue.absolute_change))
  check("percent change 712.5", eq(revenue.percent_change, 712.5), String(revenue.percent_change))
  check("direction up", revenue.direction === "up")

  check("gross profit change 3230", eq(profit.absolute_change, 3230), String(profit.absolute_change))
  check("gross profit percent 646", eq(profit.percent_change, 646), String(profit.percent_change))

  const expenses = byMetric.get("expenses") as Record<string, unknown>
  check(
    "expenses rose from ZERO -- percent change is NULL, not infinity",
    expenses.percent_change === null,
    String(expenses.percent_change)
  )
  check("but the absolute change is still reported", eq(expenses.absolute_change, 1200))
  check("and the direction is still known", expenses.direction === "up")

  /* ---------------------------------------------------------------------- */
  section("6. EMPTY PERIOD -- zeros and nulls, never NaN")

  const [emptyPeriod] = await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: "2020-01-01T00:00:00Z",
    p_to: "2020-02-01T00:00:00Z",
  })
  check("revenue 0", eq(emptyPeriod.revenue, 0))
  check("orders 0", emptyPeriod.orders_count === 0)
  check("margin is NULL, not 0", emptyPeriod.gross_margin === null)
  check("AOV is NULL, not 0", emptyPeriod.avg_order_value === null)
  check("cost coverage is NULL, not 100", emptyPeriod.cost_coverage === null)
  check("cost gap is NULL too, not 0 -- there is nothing to have a gap in",
    emptyPeriod.cost_gap === null, String(emptyPeriod.cost_gap))
  check("fee gap is NULL, not 0", emptyPeriod.fee_gap === null, String(emptyPeriod.fee_gap))

  const emptyChannels = await rpc("analytics_channels", {
    p_business_id: businessId,
    p_from: "2020-01-01T00:00:00Z",
    p_to: "2020-02-01T00:00:00Z",
  })
  check("no channel rows for an empty period", emptyChannels.length === 0)

  /* ---------------------------------------------------------------------- */
  section("7. HEALTH INPUTS")

  const [health] = await rpc("analytics_health_inputs", {
    p_business_id: businessId,
    p_from: FROM,
    p_to: TO,
    p_prev_from: PREV_FROM,
    p_prev_to: PREV_TO,
  })

  check("revenue growth 712.5%", eq(health.revenue_growth_pct, 712.5), String(health.revenue_growth_pct))
  check("gross margin 57.38", eq(health.gross_margin, 57.38))
  check("cost coverage 100", eq(health.cost_coverage, 100))
  check(
    "cancelled rate = 1 of 5 = 20%",
    eq(health.cancelled_rate, 20),
    String(health.cancelled_rate)
  )
  check(
    "repeat customer rate = 1 of 3 = 33.33%",
    eq(health.repeat_customer_rate, 33.33),
    String(health.repeat_customer_rate)
  )
  check("no payments recorded, so capture rate is NULL", health.payment_capture_rate === null)

  /* ---------------------------------------------------------------------- */
  section("8. TENANT ISOLATION at the analytics layer")

  if (OTHER_EMAIL && OTHER_PASSWORD) {
    const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)

    const [stolen] = await rpc(
      "analytics_financials",
      { p_business_id: businessId, p_from: FROM, p_to: TO },
      otherToken
    )
    check("another tenant sees revenue 0", eq(stolen.revenue, 0), String(stolen.revenue))
    check("and 0 orders", stolen.orders_count === 0)
    check("and no cost data", stolen.items_total === 0)

    const stolenChannels = await rpc(
      "analytics_channels",
      { p_business_id: businessId, p_from: FROM, p_to: TO },
      otherToken
    )
    check("and no channel rows", stolenChannels.length === 0)

    const stolenProducts = await rpc(
      "analytics_products",
      { p_business_id: businessId, p_from: FROM, p_to: TO, p_limit: 50 },
      otherToken
    )
    check("and no product rows", stolenProducts.length === 0)

    const stolenCompare = await rpc(
      "analytics_compare",
      { p_business_id: businessId, p_from: FROM, p_to: TO, p_prev_from: PREV_FROM, p_prev_to: PREV_TO },
      otherToken
    )
    const stolenRevenue = stolenCompare.find((c: { metric: string }) => c.metric === "revenue")
    check("and comparisons return zeros", eq(stolenRevenue.current_value, 0))
  } else {
    console.log("  SKIPPED -- set BIZMIND_OTHER_EMAIL / BIZMIND_OTHER_PASSWORD to run")
  }

  const anonymous = await fetch(`${SUPABASE_URL}/rest/v1/rpc/analytics_financials`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ p_business_id: businessId, p_from: FROM, p_to: TO }),
  })
  check(
    "an anonymous caller is refused outright",
    anonymous.status === 401 || anonymous.status === 403,
    String(anonymous.status)
  )
} finally {
  section("Cleanup")
  await api(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" })
  const gone = await api(`/rest/v1/businesses?select=id&id=eq.${businessId}`)
  check("throwaway tenant deleted", gone.length === 0)
}

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
