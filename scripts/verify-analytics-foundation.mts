/**
 * The analytics foundation, against the real database (migration 0025).
 *
 * Run with:  npm run test:analytics-foundation
 *
 * A small business is built in a throwaway tenant, shaped so that every
 * change 0025 makes shows up in a figure worked out by hand below:
 *
 *   - a channel filter, including "orders with no channel"
 *   - expenses and net profit refusing to be split across channels
 *   - a line with a unit price but no line total (value CALCULATED)
 *   - a line with neither (value UNKNOWN -- left out, never zero)
 *   - products named from the catalogue, the order line, or not at all
 *
 * Tenant isolation is asserted with a second business and a channel id that
 * belongs to it.
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

/** Compares an exact decimal by value, so 1830 and "1830.0000" match. */
function eq(actual: unknown, expected: number): boolean {
  return actual !== null && actual !== undefined && Number(actual) === expected
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
 * Window 2026-05-01 .. 2026-06-01. Previous 2026-04-01 .. 2026-05-01.
 * Catalogue: product P3, "Catalogue Mug".
 *
 *   A1  Amazon   total 1000  fee 100   P1 "Blue Shirt" 2 x 400, line 800, cost 300
 *   A2  Amazon   total  600  fee  --   P1 "Blue Shirt" 1 x 500, NO LINE TOTAL, cost 300
 *                                       -> value CALCULATED: 1 x 500 = 500
 *   A3  Amazon   CANCELLED -- excluded from every figure
 *   W1  Website  total  900  fee   0   P2 "Red Mug" 3 x (no price), NO LINE TOTAL, cost 100
 *                                       -> value UNKNOWN: left out of line revenue
 *   W2  Website  total  400  fee  20   "Gift wrap" (no SKU) 1 x 50, line 50, no cost
 *                                      (no SKU, no name)     line 350, cost 200
 *   U1  (none)   total  250  fee   0   P3 (no name on the line) line 250, cost 100
 *   PREV-A  Amazon, previous period: total 500, fee 50, P1 line 500, cost 300
 *   Expenses: 300 in the window.
 *
 * WHOLE BUSINESS
 *   revenue   1000+600+900+400+250                 = 3150
 *   fees      100+0+0+20+0 (A2 unknown, not zero)   =  120   fees unknown on 1 order
 *   cogs      600+300+300+0+200+100                 = 1500   (5 of 6 lines costed)
 *   profit    3150-1500-120                         = 1530
 *   expenses 300, net profit 1530-300               = 1230
 *   line revenue 800+500+50+350+250                 = 1950   (W1 unknown, left out)
 *     of which calculated                                500   on 1 line; 1 line unknown
 *
 * AMAZON        revenue 1600  fees 100  cogs 900  profit 600  margin 37.50
 *               expenses / net profit: NULL (never allocated to a channel)
 * WEBSITE       revenue 1300  fees  20  cogs 500  profit 780  margin 60.00
 * NO CHANNEL    revenue  250            cogs 100  profit 150
 *   1600 + 1300 + 250 = 3150
 *
 * PRODUCTS
 *   P1   "Blue Shirt" (order line)   revenue 1300 (500 calculated)  cogs 900
 *        fees 100  profit 300  margin 23.08
 *   P2   "Red Mug" (order line)      revenue NULL, profit NULL -- 1 line unknown
 *   Gift wrap (by name, no SKU)      revenue 50  fees 2.5  profit 47.5
 *   Lines with no product identity   revenue 350  cogs 200  fees 17.5  profit 132.5
 *   P3   "Catalogue Mug" (catalogue) revenue 250  cogs 100  profit 150
 *   known revenue 1300+50+350+250 = 1950 = line revenue; fees 100+2.5+17.5 = 120
 * ========================================================================== */

const FROM = "2026-05-01T00:00:00Z"
const TO = "2026-06-01T00:00:00Z"
const PREV_FROM = "2026-04-01T00:00:00Z"
const PREV_TO = "2026-05-01T00:00:00Z"

section("Setup -- a three-way business in a throwaway tenant")

token = await signIn(EMAIL, PASSWORD)
const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)

const suffix = Date.now().toString(36)
const business = await rpc("create_business", {
  p_name: `Foundation Verify ${suffix}`,
  p_slug: `foundation-verify-${suffix}`,
  p_currency: "BDT",
})
const businessId = business.id as string

const rival = await rpc(
  "create_business",
  { p_name: `Foundation Rival ${suffix}`, p_slug: `foundation-rival-${suffix}`, p_currency: "BDT" },
  otherToken
)
const rivalId = rival.id as string

try {
  const [amazon] = await api("/rest/v1/channels", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId, name: "Amazon", type: "AMAZON" }),
  })
  const [website] = await api("/rest/v1/channels", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId, name: "Website", type: "WEBSITE" }),
  })
  const [catalogueMug] = await api("/rest/v1/products", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId, sku: "P3", name: "Catalogue Mug" }),
  })
  const [rivalChannel] = await api(
    "/rest/v1/channels",
    { method: "POST", body: JSON.stringify({ business_id: rivalId, name: "Rival Shop", type: "WEBSITE" }) },
    otherToken
  )

  type Line = {
    sku?: string
    name?: string
    qty: number
    price: number | null
    lineTotal: number | null
    cost: number | null
  }

  const orderIds: Record<string, string> = {}

  async function order(
    number: string,
    channelId: string | null,
    placedAt: string,
    total: number,
    fee: number | null,
    status: string,
    lines: Line[]
  ) {
    const [row] = await api("/rest/v1/orders", {
      method: "POST",
      body: JSON.stringify({
        business_id: businessId,
        channel_id: channelId,
        order_number: `${number}-${suffix}`,
        status,
        currency: "BDT",
        fee_total: fee === null ? null : String(fee),
        total: String(total),
        placed_at: placedAt,
      }),
    })
    orderIds[number] = row.id

    for (const line of lines) {
      await api("/rest/v1/order_items", {
        method: "POST",
        body: JSON.stringify({
          business_id: businessId,
          order_id: row.id,
          sku: line.sku ?? null,
          name: line.name ?? null,
          quantity: String(line.qty),
          unit_price: line.price === null ? null : String(line.price),
          unit_cost: line.cost === null ? null : String(line.cost),
          line_total: line.lineTotal === null ? null : String(line.lineTotal),
        }),
      })
    }
  }

  await order("A1", amazon.id, "2026-05-03T10:00:00Z", 1000, 100, "FULFILLED", [
    { sku: "P1", name: "Blue Shirt", qty: 2, price: 400, lineTotal: 800, cost: 300 },
  ])
  await order("A2", amazon.id, "2026-05-06T10:00:00Z", 600, null, "FULFILLED", [
    { sku: "P1", name: "Blue Shirt", qty: 1, price: 500, lineTotal: null, cost: 300 },
  ])
  await order("A3", amazon.id, "2026-05-08T10:00:00Z", 999, 50, "CANCELLED", [
    { sku: "P1", name: "Blue Shirt", qty: 1, price: 999, lineTotal: 999, cost: 300 },
  ])
  await order("W1", website.id, "2026-05-10T10:00:00Z", 900, 0, "FULFILLED", [
    { sku: "P2", name: "Red Mug", qty: 3, price: null, lineTotal: null, cost: 100 },
  ])
  await order("W2", website.id, "2026-05-12T10:00:00Z", 400, 20, "FULFILLED", [
    { name: "Gift wrap", qty: 1, price: 50, lineTotal: 50, cost: null },
    { qty: 1, price: null, lineTotal: 350, cost: 200 },
  ])
  await order("U1", null, "2026-05-14T10:00:00Z", 250, 0, "FULFILLED", [
    { sku: "P3", qty: 1, price: 250, lineTotal: 250, cost: 100 },
  ])
  await order("PREV-A", amazon.id, "2026-04-10T10:00:00Z", 500, 50, "FULFILLED", [
    { sku: "P1", name: "Blue Shirt", qty: 1, price: 500, lineTotal: 500, cost: 300 },
  ])
  await api("/rest/v1/expenses", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId, category: "Rent", amount: "300",
      currency: "BDT", incurred_at: "2026-05-15T00:00:00Z",
    }),
  })

  const window = { p_business_id: businessId, p_from: FROM, p_to: TO }
  const inAmazon = { ...window, p_channel_id: amazon.id }
  const inWebsite = { ...window, p_channel_id: website.id }
  const noChannel = { ...window, p_no_channel: true }

  /* ---------------------------------------------------------------------- */
  section("1. THE WHOLE BUSINESS -- unchanged calls, unchanged meaning")

  const [all] = await rpc("analytics_financials", window)
  check("revenue = 3150", eq(all.revenue, 3150), String(all.revenue))
  check("fees = 120, the unrecorded fee counted as unknown, not zero",
    eq(all.fees, 120) && all.orders_fees_unknown === 1, `${all.fees} / ${all.orders_fees_unknown}`)
  check("cost of goods = 1500", eq(all.cogs, 1500), String(all.cogs))
  check("gross profit = 1530", eq(all.gross_profit, 1530), String(all.gross_profit))
  check("expenses = 300 and net profit = 1230 for the whole business",
    eq(all.expenses, 300) && eq(all.net_profit, 1230), `${all.expenses} / ${all.net_profit}`)
  check("the cancelled order is excluded, and counted separately",
    all.orders_count === 5 && all.cancelled_orders === 1, `${all.orders_count} / ${all.cancelled_orders}`)
  check("these figures are not channel-scoped", all.channel_scoped === false)

  /* ---------------------------------------------------------------------- */
  section("2. A BLANK LINE TOTAL IS NOT ZERO")

  check("LINE REVENUE = 1950: the calculated line counts, the unknown one is left out",
    eq(all.line_revenue, 1950), String(all.line_revenue))
  check("of which 500 was CALCULATED as quantity x unit price, on 1 line",
    eq(all.line_revenue_derived, 500) && all.items_value_derived === 1,
    `${all.line_revenue_derived} / ${all.items_value_derived}`)
  check("and 1 line has no value at all -- reported, not zeroed", all.items_value_unknown === 1)
  check("the calculated figure is returned as exact text", typeof all.line_revenue_derived === "string")

  const [storedA2] = await api(`/rest/v1/order_items?select=line_total,unit_price&order_id=eq.${orderIds.A2}`)
  check("THE SOURCE'S OWN FIELDS ARE UNTOUCHED: the order line still has no line total",
    storedA2.line_total === null && eq(storedA2.unit_price, 500), JSON.stringify(storedA2))

  /* ---------------------------------------------------------------------- */
  section("3. CHANNEL IS A DIMENSION")

  const [amz] = await rpc("analytics_financials", inAmazon)
  check("AMAZON ONLY: revenue 1600, fees 100, cost 900, profit 600, margin 37.50",
    eq(amz.revenue, 1600) && eq(amz.fees, 100) && eq(amz.cogs, 900) &&
      eq(amz.gross_profit, 600) && eq(amz.gross_margin, 37.5),
    `${amz.revenue} ${amz.fees} ${amz.cogs} ${amz.gross_profit} ${amz.gross_margin}`)
  check("with its own orders, unknown fees and cancelled order",
    amz.orders_count === 2 && amz.orders_fees_unknown === 1 && amz.cancelled_orders === 1)
  check("EXPENSES AND NET PROFIT ARE NOT SPLIT ACROSS CHANNELS -- they come back empty",
    amz.expenses === null && amz.net_profit === null && amz.net_margin === null,
    `${amz.expenses} / ${amz.net_profit} / ${amz.net_margin}`)
  check("and the figures say they are channel-scoped", amz.channel_scoped === true)
  check("its line revenue includes its calculated line", eq(amz.line_revenue, 1300) && eq(amz.line_revenue_derived, 500))

  const [web] = await rpc("analytics_financials", inWebsite)
  check("WEBSITE ONLY: revenue 1300, fees 20, cost 500, profit 780, margin 60.00",
    eq(web.revenue, 1300) && eq(web.fees, 20) && eq(web.cogs, 500) &&
      eq(web.gross_profit, 780) && eq(web.gross_margin, 60),
    `${web.revenue} ${web.fees} ${web.cogs} ${web.gross_profit} ${web.gross_margin}`)

  const [none] = await rpc("analytics_financials", noChannel)
  check("ORDERS WITH NO CHANNEL are their own slice: revenue 250, profit 150",
    eq(none.revenue, 250) && eq(none.gross_profit, 150) && none.orders_count === 1,
    `${none.revenue} ${none.gross_profit}`)

  check("THE SLICES ADD UP: 1600 + 1300 + 250 = 3150",
    Number(amz.revenue) + Number(web.revenue) + Number(none.revenue) === Number(all.revenue))

  const channels = await rpc("analytics_channels", window)
  check("the channel table still lists every channel, including the unattributed one",
    channels.length === 3, String(channels.length))
  const oneChannel = await rpc("analytics_channels", inAmazon)
  check("filtered to Amazon it lists only Amazon",
    oneChannel.length === 1 && oneChannel[0].channel_name === "Amazon" && eq(oneChannel[0].revenue, 1600))

  const compare = await rpc("analytics_compare", {
    ...window, p_prev_from: PREV_FROM, p_prev_to: PREV_TO, p_channel_id: amazon.id,
  })
  const revenueChange = compare.find((c: { metric: string }) => c.metric === "revenue")
  const netChange = compare.find((c: { metric: string }) => c.metric === "net_profit")
  check("THE TREND FOLLOWS THE CHANNEL: Amazon 1600 vs 500 is +220.00%",
    eq(revenueChange.current_value, 1600) && eq(revenueChange.previous_value, 500) &&
      eq(revenueChange.percent_change, 220) && revenueChange.direction === "up",
    JSON.stringify(revenueChange))
  check("and net profit has no channel trend -- unknown, not zero",
    netChange.direction === "unknown" && netChange.current_value === null)

  const [recAmazon] = await rpc("analytics_reconciliation", inAmazon)
  check("Amazon reconciles with itself, and its lines fall 300 short of its order totals",
    eq(recAmazon.channel_difference, 0) && eq(recAmazon.order_line_gap, 300),
    JSON.stringify(recAmazon))

  /* ---------------------------------------------------------------------- */
  section("4. PRODUCTS ARE IDENTIFIED HONESTLY")

  type Product = {
    product_key: string
    product_id: string | null
    sku: string | null
    product_name: string
    name_source: string
    revenue: string | null
    revenue_derived: string
    cogs: string
    fees_allocated: string
    gross_profit: string | null
    gross_margin: string | null
    units_sold: string
    items_value_unknown: number
    items_value_derived: number
    items_measured: number
    cost_coverage: string | null
  }

  const products = (await rpc("analytics_products", { ...window, p_limit: 50 })) as Product[]
  const byKey = new Map(products.map((p) => [p.product_key, p]))
  const p1 = byKey.get("sku:P1")
  const p2 = byKey.get("sku:P2")
  const p3 = byKey.get("sku:P3")
  const gift = byKey.get("name:gift wrap")
  const unidentified = byKey.get("unidentified")

  check("NO ROW IS CALLED \"(unnamed)\" OR \"(no SKU)\"",
    products.every((p) => !/\(unnamed\)|\(no SKU\)/.test(`${p.product_name} ${p.sku}`)),
    products.map((p) => `${p.product_key}=${p.product_name}`).join(", "))

  check("P1 is named from its order lines",
    p1?.product_name === "Blue Shirt" && p1?.name_source === "ORDER_LINE")
  check("P1: revenue 1300 of which 500 calculated, cost 900, fees 100, profit 300, margin 23.08",
    eq(p1?.revenue, 1300) && eq(p1?.revenue_derived, 500) && eq(p1?.cogs, 900) &&
      eq(p1?.fees_allocated, 100) && eq(p1?.gross_profit, 300) && eq(p1?.gross_margin, 23.08),
    JSON.stringify(p1))

  check("P2 HAS NO KNOWN LINE VALUE: revenue and profit are empty, not zero",
    p2 !== undefined && p2.revenue === null && p2.gross_profit === null && p2.gross_margin === null,
    JSON.stringify(p2))
  check("and it says so: 1 line of unknown value, none measured, no cost counted against it",
    p2?.items_value_unknown === 1 && p2?.items_measured === 0 && eq(p2?.cogs, 0) && eq(p2?.units_sold, 3))

  check("P3 IS NAMED FROM THE CATALOGUE when its order line carries no name",
    p3?.product_name === "Catalogue Mug" && p3?.name_source === "CATALOGUE" &&
      p3?.product_id === catalogueMug.id,
    JSON.stringify(p3))
  check("P3: revenue 250, profit 150", eq(p3?.revenue, 250) && eq(p3?.gross_profit, 150))

  check("A LINE WITH A NAME BUT NO SKU IS ITS OWN PRODUCT, not merged into a bucket",
    gift?.sku === null && gift?.product_name === "Gift wrap" && eq(gift?.revenue, 50) &&
      eq(gift?.fees_allocated, 2.5) && eq(gift?.gross_profit, 47.5),
    JSON.stringify(gift))
  check("and its missing cost is reported as 0% coverage", eq(gift?.cost_coverage, 0))

  check("LINES WITH NO IDENTITY AT ALL FORM ONE ROW THAT SAYS SO",
    unidentified?.product_name === "Lines with no product identity" &&
      unidentified?.name_source === "NONE" && eq(unidentified?.revenue, 350) &&
      eq(unidentified?.gross_profit, 132.5),
    JSON.stringify(unidentified))

  const knownRevenue = products.reduce((sum, p) => sum + (p.revenue === null ? 0 : Number(p.revenue)), 0)
  const feeTotal = products.reduce((sum, p) => sum + Number(p.fees_allocated), 0)
  check("PRODUCTS ADD UP: known product revenue = line revenue = 1950", knownRevenue === 1950, String(knownRevenue))
  check("and the allocated fees add back to the 120 charged", feeTotal === 120, String(feeTotal))

  const amazonProducts = (await rpc("analytics_products", { ...inAmazon, p_limit: 50 })) as Product[]
  check("PRODUCT FIGURES FOLLOW THE CHANNEL: Amazon sold only P1, and not its cancelled line",
    amazonProducts.length === 1 && amazonProducts[0].product_key === "sku:P1" &&
      eq(amazonProducts[0].revenue, 1300),
    JSON.stringify(amazonProducts.map((p) => [p.product_key, p.revenue])))

  check("product money is exact text", typeof p1?.revenue_derived === "string" && typeof p1?.revenue === "string")

  /* ---------------------------------------------------------------------- */
  section("5. TENANT ISOLATION WITH A CHANNEL")

  const [foreignChannel] = await rpc("analytics_financials", { ...window, p_channel_id: rivalChannel.id })
  check("ANOTHER BUSINESS'S CHANNEL ID, used on this business, matches nothing",
    eq(foreignChannel.revenue, 0) && foreignChannel.orders_count === 0)

  const [stolen] = await rpc("analytics_financials", inAmazon, otherToken)
  check("ANOTHER BUSINESS ASKING FOR THIS ONE'S AMAZON FIGURES SEES NOTHING",
    eq(stolen.revenue, 0) && stolen.orders_count === 0 && stolen.items_total === 0)

  const stolenProducts = await rpc("analytics_products", { ...inAmazon, p_limit: 50 }, otherToken)
  check("nor its products", stolenProducts.length === 0)

  const [ownWithOurs] = await rpc(
    "analytics_financials",
    { p_business_id: rivalId, p_from: FROM, p_to: TO, p_channel_id: amazon.id },
    otherToken
  )
  check("and this business's channel id, used on the other business, matches nothing there either",
    eq(ownWithOurs.revenue, 0))

  const anonymous = await fetch(`${SUPABASE_URL}/rest/v1/rpc/analytics_financials`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(inAmazon),
  })
  check("an anonymous caller is refused", anonymous.status === 401 || anonymous.status === 403,
    String(anonymous.status))
} finally {
  section("Cleanup")
  await api(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" })
  await api(`/rest/v1/businesses?id=eq.${rivalId}`, { method: "DELETE" }, otherToken)
}

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
