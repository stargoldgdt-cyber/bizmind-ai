/**
 * Regression tests for historical cost stability.
 *
 * Run with:  npm run test:costs
 *
 * These guard the single most valuable promise in the product: a figure you
 * saw last month still means the same thing today. Re-pricing a product must
 * never move a past order's profit, and an order imported without a cost must
 * never quietly borrow one from the catalogue.
 *
 * Everything runs inside a throwaway business that is deleted at the end, so
 * the tests never touch real data.
 *
 * Credentials come from the environment, never from this file:
 *   BIZMIND_TEST_EMAIL, BIZMIND_TEST_PASSWORD
 */

import { readFileSync } from "node:fs"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

/* ---- Configuration ------------------------------------------------------- */

function readEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {}
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (match) out[match[1]] = match[2].trim()
    }
    return out
  } catch {
    return {}
  }
}

const fileEnv = readEnvFile(".env.local")
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fileEnv.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY
const EMAIL = process.env.BIZMIND_TEST_EMAIL
const PASSWORD = process.env.BIZMIND_TEST_PASSWORD

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("Supabase is not configured. Set up .env.local first.")
  process.exit(1)
}
if (!EMAIL || !PASSWORD) {
  console.error(
    "Set BIZMIND_TEST_EMAIL and BIZMIND_TEST_PASSWORD to run the cost-stability tests.\n" +
      "They are read from the environment so no credential is ever committed."
  )
  process.exit(1)
}

/* ---- Tiny REST helper ---------------------------------------------------- */

let accessToken = ""

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`)
  }
  return body
}

const rpc = (fn: string, args: unknown) =>
  api(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) })

/* ---- Fixtures ------------------------------------------------------------ */

let businessId = ""

async function makeBatch(entity: "ORDERS" | "PRODUCTS") {
  const rows = await api("/rest/v1/import_batches", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      entity,
      status: "DRAFT",
      source: "MANUAL",
      file_name: `cost-stability-${entity.toLowerCase()}.csv`,
      file_type: "csv",
      file_size_bytes: 128,
      row_count: 1,
    }),
  })
  return rows[0].id as string
}

async function importProduct(sku: string, name: string, cost: string) {
  const batchId = await makeBatch("PRODUCTS")
  return rpc("import_apply_products", {
    p_batch_id: batchId,
    p_rows: [{ sku, name, unit_cost: cost }],
  })
}

async function importOrder(
  externalId: string,
  total: string,
  sku: string,
  quantity: string,
  unitCost: string | null
) {
  const batchId = await makeBatch("ORDERS")
  return rpc("import_apply_orders", {
    p_batch_id: batchId,
    p_rows: [
      {
        external_id: externalId,
        placed_at: "2026-06-01T00:00:00Z",
        status: "FULFILLED",
        currency: "BDT",
        subtotal: total,
        discount_total: "0",
        tax_total: "0",
        shipping_total: "0",
        fee_total: "0",
        total,
        items: [
          {
            sku,
            name: "Stability Widget",
            quantity,
            unit_price: total,
            unit_cost: unitCost,
            discount: "0",
            tax: "0",
            line_total: total,
          },
        ],
      },
    ],
  })
}

async function summary() {
  const rows = await rpc("dashboard_summary", {
    p_business_id: businessId,
    p_from: "2026-01-01T00:00:00Z",
    p_to: "2027-01-01T00:00:00Z",
  })
  return rows[0]
}

async function lineFor(externalId: string) {
  const orders = await api(
    `/rest/v1/orders?select=id&external_id=eq.${externalId}&business_id=eq.${businessId}`
  )
  const items = await api(
    `/rest/v1/order_items?select=unit_cost,cost_missing,quantity&order_id=eq.${orders[0].id}`
  )
  return items[0] as { unit_cost: string | null; cost_missing: boolean; quantity: string }
}

/* ---- Run ----------------------------------------------------------------- */

section("Setup — signing in and creating a throwaway business")

const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
if (!auth.ok) {
  console.error("Could not sign in with the supplied test credentials.")
  process.exit(1)
}
accessToken = (await auth.json()).access_token

const suffix = Date.now().toString(36)
const business = await rpc("create_business", {
  p_name: `Cost Stability ${suffix}`,
  p_slug: `cost-stability-${suffix}`,
  p_currency: "BDT",
})
businessId = business.id
console.log(`  isolated business: ${business.name}`)

try {
  /* ---------------------------------------------------------------------- */
  section("1. An order imported WITHOUT a cost must not inherit the catalogue cost")

  await importProduct("STABLE-1", "Stability Widget", "100")
  await importOrder("ORD-NOCOST", "500", "STABLE-1", "2", null)

  const noCost = await lineFor("ORD-NOCOST")
  check(
    "line cost stays NULL even though the catalogue says 100",
    noCost.unit_cost === null,
    `got ${noCost.unit_cost}`
  )
  check("line is marked cost_missing", noCost.cost_missing === true)

  const afterNoCost = await summary()
  check(
    "cost of goods is 0, not 200 borrowed from the catalogue",
    Number(afterNoCost.cogs) === 0,
    `got ${afterNoCost.cogs}`
  )
  check(
    "the gap is reported: 1 item, 0 with cost",
    afterNoCost.items_total === 1 && afterNoCost.items_with_cost === 0,
    `${afterNoCost.items_with_cost}/${afterNoCost.items_total}`
  )

  /* ---------------------------------------------------------------------- */
  section("2. An order imported WITH an explicit cost stores exactly that cost")

  await importOrder("ORD-WITHCOST", "300", "STABLE-1", "1", "60")

  const withCost = await lineFor("ORD-WITHCOST")
  check(
    "line cost is 60 from the file, not 100 from the catalogue",
    Number(withCost.unit_cost) === 60,
    `got ${withCost.unit_cost}`
  )
  check("line is not marked cost_missing", withCost.cost_missing === false)

  const baseline = await summary()
  check(
    "cost of goods is 1 x 60 = 60",
    Number(baseline.cogs) === 60,
    `got ${baseline.cogs}`
  )
  check(
    "gross profit 800 - 60 = 740",
    Number(baseline.gross_profit) === 740,
    `got ${baseline.gross_profit}`
  )

  /* ---------------------------------------------------------------------- */
  section("3. RE-IMPORTING the product at a new cost must not move past profit")

  await importProduct("STABLE-1", "Stability Widget", "500")

  const variantAfter = await api(
    `/rest/v1/product_variants?select=unit_cost&sku=eq.STABLE-1&business_id=eq.${businessId}`
  )
  check(
    "catalogue cost did change, so the test is meaningful",
    Number(variantAfter[0].unit_cost) === 500,
    `got ${variantAfter[0].unit_cost}`
  )

  const afterRepriceImport = await summary()
  check(
    "cost of goods unchanged at 60",
    Number(afterRepriceImport.cogs) === Number(baseline.cogs),
    `${baseline.cogs} -> ${afterRepriceImport.cogs}`
  )
  check(
    "gross profit unchanged at 740",
    Number(afterRepriceImport.gross_profit) === Number(baseline.gross_profit),
    `${baseline.gross_profit} -> ${afterRepriceImport.gross_profit}`
  )
  check(
    "the costless order STILL has no cost",
    (await lineFor("ORD-NOCOST")).unit_cost === null
  )
  check(
    "the costed order still records 60, not 500",
    Number((await lineFor("ORD-WITHCOST")).unit_cost) === 60
  )

  /* ---------------------------------------------------------------------- */
  section("4. EDITING the catalogue cost directly must not move past profit")

  await api(
    `/rest/v1/product_variants?sku=eq.STABLE-1&business_id=eq.${businessId}`,
    { method: "PATCH", body: JSON.stringify({ unit_cost: "999" }) }
  )

  const afterDirectEdit = await summary()
  check(
    "cost of goods still 60 after the catalogue jumped to 999",
    Number(afterDirectEdit.cogs) === Number(baseline.cogs),
    `${baseline.cogs} -> ${afterDirectEdit.cogs}`
  )
  check(
    "gross profit still 740",
    Number(afterDirectEdit.gross_profit) === Number(baseline.gross_profit),
    `${baseline.gross_profit} -> ${afterDirectEdit.gross_profit}`
  )
  check(
    "margin still identical",
    afterDirectEdit.gross_margin === baseline.gross_margin,
    `${baseline.gross_margin} -> ${afterDirectEdit.gross_margin}`
  )

  /* ---------------------------------------------------------------------- */
  section("5. RE-IMPORTING the same order must not change its recorded cost")

  await importOrder("ORD-WITHCOST", "300", "STABLE-1", "1", "60")
  const reimported = await lineFor("ORD-WITHCOST")
  check("cost still 60 after re-import", Number(reimported.unit_cost) === 60)

  const afterReimport = await summary()
  check(
    "gross profit still 740 after re-import",
    Number(afterReimport.gross_profit) === Number(baseline.gross_profit),
    `${baseline.gross_profit} -> ${afterReimport.gross_profit}`
  )

  /* ---------------------------------------------------------------------- */
  section("6. Order lines are still linked to the catalogue (identity, not money)")

  const linked = await api(
    `/rest/v1/order_items?select=variant_id,unit_cost&business_id=eq.${businessId}`
  )
  check(
    "every line is linked to its product variant",
    linked.every((l: { variant_id: string | null }) => l.variant_id !== null)
  )
  check(
    "linking did not populate any cost",
    linked.filter((l: { unit_cost: string | null }) => l.unit_cost === null).length === 1
  )
} finally {
  section("Cleanup")
  await api(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" })
  const gone = await api(`/rest/v1/businesses?select=id&id=eq.${businessId}`)
  check("throwaway business deleted", gone.length === 0)
}

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
