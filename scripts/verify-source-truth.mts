/**
 * Source truth: blank is not zero, and a source field is not a metric.
 *
 * Run with:  npm run test:source-truth
 *
 * Two properties that are easy to state and easy to lose. A blank cell turning
 * into a recorded zero, or a column called "Wholesale Price" quietly becoming
 * cost of goods, both produce confident numbers that are wrong -- and both are
 * invisible once they have happened.
 *
 * Runs in a throwaway tenant, deleted at the end.
 *
 * Credentials from the environment:
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

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

const { url: SUPABASE_URL, anonKey: ANON_KEY, email: EMAIL, password: PASSWORD } =
  requireConfig()

let token = ""

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`)
  return body
}

/** Returns the error instead of throwing, for the cases that must be refused. */
async function apiExpectFailure(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text }
}

const rpc = (fn: string, args: unknown) =>
  api(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) })

const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
if (!auth.ok) {
  console.error("Could not sign in with the supplied test credentials.")
  process.exit(1)
}
token = (await auth.json()).access_token

section("Setup")
const suffix = Date.now().toString(36)
const business = await rpc("create_business", {
  p_name: `Source Truth ${suffix}`,
  p_slug: `source-truth-${suffix}`,
  p_currency: "AED",
})
const businessId = business.id as string
console.log(`  tenant: ${business.name}`)

try {
  /* ---------------------------------------------------------------------- */
  section("1. BLANK IS NOT ZERO -- through the real import pipeline")

  async function importOrders(rows: unknown[]) {
    const [batch] = await api("/rest/v1/import_batches", {
      method: "POST",
      body: JSON.stringify({
        business_id: businessId,
        entity: "ORDERS",
        status: "DRAFT",
        source: "AMAZON",
        file_name: "source-truth.csv",
        file_type: "csv",
        file_size_bytes: 256,
        row_count: rows.length,
      }),
    })
    return rpc("import_apply_orders", { p_batch_id: batch.id, p_rows: rows })
  }

  const result = await importOrders([
    {
      // Fee column absent entirely -- the file did not say.
      external_id: "NO-FEE-COLUMN",
      placed_at: "2026-01-07T00:00:00Z",
      status: "FULFILLED",
      currency: "AED",
      total: "3243.99",
      subtotal: null,
      discount_total: null,
      tax_total: null,
      shipping_total: null,
      fee_total: null,
      items: [
        {
          sku: "W-1", name: "Widget", quantity: "1",
          unit_price: null, unit_cost: "3242.40", discount: null, tax: null, line_total: null,
        },
      ],
    },
    {
      // Fee explicitly recorded as zero -- the file DID say, and said none.
      external_id: "ZERO-FEE-RECORDED",
      placed_at: "2026-01-08T00:00:00Z",
      status: "FULFILLED",
      currency: "AED",
      total: "1000.00",
      subtotal: "1000.00",
      discount_total: "0",
      tax_total: "0",
      shipping_total: "0",
      fee_total: "0",
      items: [
        {
          sku: "W-2", name: "Widget Two", quantity: "1",
          unit_price: "1000.00", unit_cost: "400.00", discount: "0", tax: "0", line_total: "1000.00",
        },
      ],
    },
  ])

  check("both orders imported", result.orders_created === 2, JSON.stringify(result))
  check(
    "the importer counted the order with no fee",
    result.orders_missing_fees === 1,
    String(result.orders_missing_fees)
  )

  const orders = await api(
    `/rest/v1/orders?select=external_id,fee_total,subtotal,unit:order_items(unit_price,line_total,discount)&business_id=eq.${businessId}&order=external_id.asc`
  )
  const noFee = orders.find((o: { external_id: string }) => o.external_id === "NO-FEE-COLUMN")
  const zeroFee = orders.find((o: { external_id: string }) => o.external_id === "ZERO-FEE-RECORDED")

  check("an absent fee is stored as NULL, not 0", noFee.fee_total === null, String(noFee.fee_total))
  check("an absent subtotal is stored as NULL", noFee.subtotal === null, String(noFee.subtotal))
  check(
    "an absent unit price is stored as NULL",
    noFee.unit[0].unit_price === null,
    String(noFee.unit[0].unit_price)
  )
  check(
    "a RECORDED zero fee stays 0, not NULL",
    zeroFee.fee_total !== null && Number(zeroFee.fee_total) === 0,
    String(zeroFee.fee_total)
  )
  check(
    "THE DISTINCTION HOLDS: unknown and zero are different in the database",
    noFee.fee_total === null && Number(zeroFee.fee_total) === 0
  )

  /* ---------------------------------------------------------------------- */
  section("2. ANALYTICS reports the gap instead of absorbing it")

  const [f] = await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: "2026-01-01T00:00:00Z",
    p_to: "2026-02-01T00:00:00Z",
  })

  check("revenue = 4243.99", Number(f.revenue) === 4243.99, String(f.revenue))
  check(
    "fees = 0, because the only recorded fee was zero",
    Number(f.fees) === 0,
    String(f.fees)
  )
  check(
    "one order is reported as having UNKNOWN fees",
    f.orders_fees_unknown === 1,
    String(f.orders_fees_unknown)
  )
  check(
    "fee coverage = 50%, so the gap is visible",
    Number(f.fee_coverage) === 50,
    String(f.fee_coverage)
  )
  check(
    "the zero-fee order is counted separately from the unknown one",
    f.orders_zero_fees === 1,
    String(f.orders_zero_fees)
  )

  const channels = await rpc("analytics_channels", {
    p_business_id: businessId,
    p_from: "2026-01-01T00:00:00Z",
    p_to: "2026-02-01T00:00:00Z",
  })
  check(
    "channels report fee coverage too",
    channels.every((c: { fee_coverage: string | null }) => c.fee_coverage !== undefined)
  )

  /* ---------------------------------------------------------------------- */
  section("3. THE SEMANTICS GATE")

  const mapped = await apiExpectFailure("/rest/v1/source_field_semantics", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      source: "AMAZON",
      field_key: "product_wholesale_price",
      source_label: "product Wholesale Price",
      status: "PENDING_CONFIRMATION",
      maps_to: "cogs",
    }),
  })
  check("an unconfirmed field cannot map to a BizMind metric", !mapped.ok, String(mapped.status))
  check(
    "refused by a database constraint, not application code",
    mapped.body.includes("semantics_mapping_requires_confirmation"),
    mapped.body.slice(0, 120)
  )

  const forged = await apiExpectFailure("/rest/v1/source_field_semantics", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      source: "AMAZON",
      field_key: "forged",
      source_label: "forged",
      status: "CONFIRMED",
      maps_to: "cogs",
    }),
  })
  check("a CONFIRMED status cannot be set without attribution", !forged.ok)
  check(
    "also refused by constraint",
    forged.body.includes("semantics_confirmation_requires_attribution"),
    forged.body.slice(0, 120)
  )

  const preserved = await api("/rest/v1/source_field_semantics", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      source: "AMAZON",
      field_key: "product_wholesale_price",
      source_label: "product Wholesale Price",
      status: "PENDING_CONFIRMATION",
      maps_to: null,
      note: "Source-defined product wholesale cost - COGS attribution unverified.",
    }),
  })
  check(
    "but it CAN be preserved as awaiting a decision",
    preserved[0].status === "PENDING_CONFIRMATION"
  )
  check("with no mapping", preserved[0].maps_to === null)

  /* ---------------------------------------------------------------------- */
  section("4. CONFIRMING is attributable and audited")

  // The target is the CANONICAL name, `marketplace_fees`. The dashboard column
  // is called `fees`, which is a view of it -- and the database refuses the
  // view's name, because a metric must be named the one way everywhere.
  const confirmed = await rpc("confirm_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_field_key: "amazon_fees",
    p_status: "CONFIRMED",
    p_maps_to: "marketplace_fees",
    p_note: "Confirmed with the seller as marketplace commission only.",
  })
  check("a confirmation records the mapping", confirmed.maps_to === "marketplace_fees")
  check("and who made it", confirmed.confirmed_by !== null)
  check("and when", confirmed.confirmed_at !== null)

  const audit = await api(
    `/rest/v1/audit_logs?select=action,entity_type,after_data&business_id=eq.${businessId}&order=created_at.desc&limit=1`
  )
  check(
    "and writes an audit entry",
    audit[0]?.action === "source_field_semantics.confirmed",
    audit[0]?.action
  )
  check(
    "naming the field it confirmed",
    audit[0]?.after_data?.field_key === "amazon_fees"
  )

  const refused = await apiExpectFailure("/rest/v1/rpc/confirm_source_field_semantics", {
    method: "POST",
    body: JSON.stringify({
      p_business_id: businessId,
      p_source: "AMAZON",
      p_field_key: "half_confirmed",
      p_status: "CONFIRMED",
    }),
  })
  check("confirming without naming a target metric is refused", !refused.ok)

  /* ---------------------------------------------------------------------- */
  section("5. SOURCE RECORDS preserve what the file actually said")

  const [record] = await api("/rest/v1/source_records", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      source: "AMAZON",
      record_type: "settlement_period",
      external_id: `sample-${suffix}`,
      period_start: "2026-01-01T00:00:00Z",
      period_end: "2026-02-01T00:00:00Z",
      figures: {
        total_sales: "74644.49",
        total_expense: "24995.90",
        payment: "49648.59",
        product_wholesale_price: "53510.20",
        profit_loss: "-3861.61",
        cost_of_advertising: null,
        storage_fee: null,
      },
      blank_fields: ["cost_of_advertising", "storage_fee"],
      checks: [
        {
          name: "sales_minus_expense_equals_payment",
          expected: "49648.59",
          actual: "49648.59",
          passed: true,
        },
      ],
    }),
  })

  check("a blank advertising cost is stored as null", record.figures.cost_of_advertising === null)
  check(
    "and is listed in blank_fields so it stays distinguishable",
    record.blank_fields.includes("cost_of_advertising")
  )
  check("the source's own Profit/Loss is preserved verbatim", record.figures.profit_loss === "-3861.61")
  check("the reconciliation result is recorded", record.checks[0].passed === true)

  const stillUnmapped = await api(
    `/rest/v1/source_field_semantics?select=field_key,maps_to&business_id=eq.${businessId}&field_key=eq.product_wholesale_price`
  )
  check(
    "and the wholesale figure still feeds NO BizMind metric",
    stillUnmapped[0].maps_to === null
  )

  const [after] = await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: "2026-01-01T00:00:00Z",
    p_to: "2026-02-01T00:00:00Z",
  })
  check(
    "preserving a source record changed no BizMind figure",
    Number(after.revenue) === Number(f.revenue) &&
      Number(after.cogs) === Number(f.cogs) &&
      Number(after.gross_profit) === Number(f.gross_profit),
    `${f.revenue}/${f.gross_profit} -> ${after.revenue}/${after.gross_profit}`
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
