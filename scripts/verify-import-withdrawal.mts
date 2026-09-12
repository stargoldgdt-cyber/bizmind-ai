/**
 * Withdrawing an import, against the real database (migration 0027).
 *
 * Run with:  npm run test:withdrawal
 *
 * This is the destructive path, so it is tested the way a destructive path
 * should be: with a business whose every record's history is known, and an
 * assertion after every step that only what was promised changed.
 *
 * THE SHAPE OF THE TEST
 *   File A imports orders O1 and O2.
 *   File B re-imports O1 with a new total, so O1 now has two writers.
 *   File C imports a product.
 *
 * Which means:
 *   - withdrawing A must take O2 out and LEAVE O1 ALONE
 *   - the figures must fall by exactly O2's revenue, and no more
 *   - once A is withdrawn, O1 belongs only to B, so B's preview must say so
 *   - restoring A must put O2 back and nothing else
 *   - a second business must not be able to see, preview or withdraw any of it
 *   - a staff member must not be able to withdraw anything
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

/** Compares an exact decimal by value, so 1700 and "1700.0000" match. */
function eq(actual: unknown, expected: number): boolean {
  return actual !== null && actual !== undefined && Number(actual) === expected
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

/** Like `api`, but a refusal is the expected answer rather than a crash. */
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
  const text = await response.text()
  return {
    ok: response.ok,
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  }
}

const rpc = (fn: string, args: unknown, asToken = token) =>
  api(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

const tryRpc = (fn: string, args: unknown, asToken = token) =>
  attempt(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(`Could not sign in as ${email}`)
  return (await response.json()).access_token
}

async function userId(asToken: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${asToken}` },
  })
  return (await response.json()).id as string
}

type Preview = {
  file_name: string
  already_withdrawn: boolean
  can_withdraw: boolean
  blocked_reason: string | null
  records_written: number
  records_created: number
  records_updated: number
  records_exclusive: number
  records_shared: number
  orders_exclusive: number
  products_exclusive: number
  expenses_exclusive: number
  shared_with: string[]
}

type Overview = {
  batch_id: string
  file_name: string
  records_written: number
  records_withdrawn: number
  lineage_status: string
  withdrawn_at: string | null
  withdrawal_reason: string | null
  errors_count: number
  warnings_count: number
  matched_count: number
}

const FROM = "2026-09-01T00:00:00Z"
const TO = "2026-10-01T00:00:00Z"

section("Setup -- two imports that share an order, in a throwaway tenant")

token = await signIn(EMAIL, PASSWORD)
const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const otherUserId = await userId(otherToken)

const suffix = Date.now().toString(36)
const business = await rpc("create_business", {
  p_name: `Withdrawal Verify ${suffix}`,
  p_slug: `withdrawal-verify-${suffix}`,
  p_currency: "BDT",
})
const businessId = business.id as string

const rival = await rpc(
  "create_business",
  {
    p_name: `Withdrawal Rival ${suffix}`,
    p_slug: `withdrawal-rival-${suffix}`,
    p_currency: "BDT",
  },
  otherToken
)
const rivalId = rival.id as string

try {
  const order = (key: string, total: string) => ({
    external_id: `W${suffix}-${key}`,
    placed_at: "2026-09-05T10:00:00Z",
    status: "FULFILLED",
    currency: "BDT",
    subtotal: null,
    discount_total: null,
    tax_total: null,
    shipping_total: null,
    fee_total: "0",
    total,
    items: [],
  })

  async function newBatch(fileName: string, entity: "ORDERS" | "PRODUCTS") {
    const [row] = await api("/rest/v1/import_batches", {
      method: "POST",
      body: JSON.stringify({
        business_id: businessId,
        entity,
        status: "READY",
        source: "WEBSITE",
        file_name: fileName,
        file_type: "csv",
        file_size_bytes: 128,
        row_count: 2,
      }),
    })
    return row.id as string
  }

  const batchA = await newBatch(`withdraw-a-${suffix}.csv`, "ORDERS")
  await rpc("import_apply_orders", {
    p_batch_id: batchA,
    p_rows: [order("O1", "1000.00"), order("O2", "500.00")],
  })

  const batchB = await newBatch(`withdraw-b-${suffix}.csv`, "ORDERS")
  await rpc("import_apply_orders", {
    p_batch_id: batchB,
    p_rows: [order("O1", "1200.00")],
  })

  const batchC = await newBatch(`withdraw-c-${suffix}.csv`, "PRODUCTS")
  await rpc("import_apply_products", {
    p_batch_id: batchC,
    p_rows: [
      {
        sku: `WSKU-${suffix}`,
        name: "Withdrawable Widget",
        description: null,
        category: null,
        brand: null,
        unit_price: "250.00",
        unit_cost: "100.00",
        barcode: null,
      },
    ],
  })

  const orders = (await api(
    `/rest/v1/orders?select=id,external_id,total,withdrawn_at,withdrawn_by_batch` +
      `&business_id=eq.${businessId}&order=external_id.asc`
  )) as {
    id: string
    external_id: string
    total: string
    withdrawn_at: string | null
    withdrawn_by_batch: string | null
  }[]
  const o1 = orders.find((o) => o.external_id.endsWith("-O1"))!
  const o2 = orders.find((o) => o.external_id.endsWith("-O2"))!

  check("the second file updated the shared order rather than duplicating it",
    orders.length === 2 && eq(o1.total, 1200), `${orders.length} orders, O1 = ${o1.total}`)

  const window = { p_business_id: businessId, p_from: FROM, p_to: TO }
  const [before] = await rpc("analytics_financials", window)
  check("revenue before any withdrawal = 1700 (1200 + 500)",
    eq(before.revenue, 1700), String(before.revenue))

  /* ---------------------------------------------------------------------- */
  section("1. THE DATA SOURCES LIST")

  const overview = (await rpc("import_batch_overview", { p_limit: 50, p_offset: 0 })) as Overview[]
  const listedA = overview.find((row) => row.batch_id === batchA)!
  const listedB = overview.find((row) => row.batch_id === batchB)!
  const listedC = overview.find((row) => row.batch_id === batchC)!

  check("every import in this business is listed",
    Boolean(listedA && listedB && listedC), `${overview.length} rows`)
  check("newest first", overview[0].batch_id === batchC, overview[0].file_name)
  check("each row says how many records it wrote",
    listedA.records_written === 2 && listedB.records_written === 1 && listedC.records_written === 1,
    `${listedA.records_written} / ${listedB.records_written} / ${listedC.records_written}`)
  check("and that BizMind recorded what it wrote",
    [listedA, listedB, listedC].every((row) => row.lineage_status === "RECORDED"))
  check("nothing is withdrawn yet",
    [listedA, listedB, listedC].every((row) => row.withdrawn_at === null && row.records_withdrawn === 0))
  check("the total is reported for paging", listedA.matched_count >= 3, String(listedA.matched_count))

  const rivalOverview = (await rpc(
    "import_batch_overview", { p_limit: 50, p_offset: 0 }, otherToken
  )) as Overview[]
  check("TENANT ISOLATION: the other business sees none of these imports",
    !rivalOverview.some((row) => [batchA, batchB, batchC].includes(row.batch_id)),
    `${rivalOverview.length} rows visible to the rival`)

  /* ---------------------------------------------------------------------- */
  section("2. THE PREVIEW SAYS WHAT WOULD ACTUALLY HAPPEN")

  const [previewA] = (await rpc("import_batch_withdrawal_preview", {
    p_batch_id: batchA,
  })) as Preview[]

  check("it names the file", previewA.file_name.includes(`withdraw-a-${suffix}`))
  check("it wrote 2 records, both created by it",
    previewA.records_written === 2 && previewA.records_created === 2 && previewA.records_updated === 0,
    JSON.stringify(previewA))
  check("ONLY ONE WOULD STOP COUNTING -- the other is also written by file B",
    previewA.records_exclusive === 1 && previewA.records_shared === 1,
    `${previewA.records_exclusive} exclusive / ${previewA.records_shared} shared`)
  check("and it is an order", previewA.orders_exclusive === 1 &&
    previewA.products_exclusive === 0 && previewA.expenses_exclusive === 0)
  check("IT NAMES WHO ELSE WROTE THE SHARED ONE",
    previewA.shared_with.some((label) => label.includes(`withdraw-b-${suffix}`)),
    JSON.stringify(previewA.shared_with))
  check("it can be withdrawn", previewA.can_withdraw && !previewA.already_withdrawn &&
    previewA.blocked_reason === null)

  const [previewB] = (await rpc("import_batch_withdrawal_preview", {
    p_batch_id: batchB,
  })) as Preview[]
  check("file B's preview counts its one record as an UPDATE, not a creation",
    previewB.records_written === 1 && previewB.records_created === 0 && previewB.records_updated === 1,
    JSON.stringify(previewB))
  check("and as shared, because file A still stands",
    previewB.records_exclusive === 0 && previewB.records_shared === 1)

  /* ---------------------------------------------------------------------- */
  section("3. ONLY AN OWNER OR ADMIN, AND ONLY THEIR OWN BUSINESS")

  const rivalPreview = await tryRpc("import_batch_withdrawal_preview", { p_batch_id: batchA }, otherToken)
  check("ANOTHER BUSINESS CANNOT PREVIEW THIS IMPORT",
    !rivalPreview.ok, `${rivalPreview.status} ${JSON.stringify(rivalPreview.body)}`)

  const rivalWithdraw = await tryRpc("import_batch_withdraw", { p_batch_id: batchA }, otherToken)
  check("AND CANNOT WITHDRAW IT",
    !rivalWithdraw.ok, `${rivalWithdraw.status} ${JSON.stringify(rivalWithdraw.body)}`)

  const rivalRestore = await tryRpc("import_batch_restore", { p_batch_id: batchA }, otherToken)
  check("AND CANNOT RESTORE IT",
    !rivalRestore.ok, `${rivalRestore.status} ${JSON.stringify(rivalRestore.body)}`)

  const stillThere = (await api(
    `/rest/v1/orders?select=id,withdrawn_at&business_id=eq.${businessId}`
  )) as { withdrawn_at: string | null }[]
  check("after all three refusals, nothing in this business was touched",
    stillThere.every((row) => row.withdrawn_at === null))

  // The same user, now a member of this business, but only as STAFF.
  await api("/rest/v1/business_members", {
    method: "POST",
    body: JSON.stringify({ business_id: businessId, user_id: otherUserId, role: "STAFF" }),
  })

  const staffWithdraw = await tryRpc("import_batch_withdraw", { p_batch_id: batchA }, otherToken)
  check("A STAFF MEMBER OF THIS BUSINESS STILL CANNOT WITHDRAW AN IMPORT",
    !staffWithdraw.ok && JSON.stringify(staffWithdraw.body).includes("owner or admin"),
    `${staffWithdraw.status} ${JSON.stringify(staffWithdraw.body)}`)

  const staffPreview = await tryRpc("import_batch_withdrawal_preview", { p_batch_id: batchA }, otherToken)
  check("nor even see what withdrawing it would do",
    !staffPreview.ok, `${staffPreview.status} ${JSON.stringify(staffPreview.body)}`)

  const staffList = (await rpc("import_batch_overview", { p_limit: 50 }, otherToken)) as Overview[]
  check("but staff can still see the import history they are working with",
    staffList.some((row) => row.batch_id === batchA))

  /* ---------------------------------------------------------------------- */
  section("4. WITHDRAWING FILE A")

  const [result] = (await rpc("import_batch_withdraw", {
    p_batch_id: batchA,
    p_reason: "Wrong file",
  })) as {
    orders_withdrawn: number
    products_withdrawn: number
    expenses_withdrawn: number
    records_shared: number
  }[]

  check("it withdrew exactly the one order it owned alone",
    result.orders_withdrawn === 1 && result.products_withdrawn === 0 &&
      result.expenses_withdrawn === 0 && result.records_shared === 1,
    JSON.stringify(result))

  const afterOrders = (await api(
    `/rest/v1/orders?select=id,external_id,total,withdrawn_at,withdrawn_by_batch` +
      `&business_id=eq.${businessId}&order=external_id.asc`
  )) as typeof orders
  const o1After = afterOrders.find((o) => o.id === o1.id)!
  const o2After = afterOrders.find((o) => o.id === o2.id)!

  check("THE SHARED ORDER WAS NOT TOUCHED",
    o1After.withdrawn_at === null && o1After.withdrawn_by_batch === null && eq(o1After.total, 1200),
    JSON.stringify(o1After))
  check("the exclusive one is marked withdrawn, by this import",
    o2After.withdrawn_at !== null && o2After.withdrawn_by_batch === batchA, JSON.stringify(o2After))
  check("NOTHING WAS DELETED: both orders are still stored, with their values",
    afterOrders.length === 2 && eq(o2After.total, 500))

  const [afterFinancials] = await rpc("analytics_financials", window)
  check("REVENUE FELL BY EXACTLY THE WITHDRAWN ORDER: 1700 -> 1200",
    eq(afterFinancials.revenue, 1200), String(afterFinancials.revenue))
  check("and the order count with it", afterFinancials.orders_count === 1,
    String(afterFinancials.orders_count))

  const auditRows = (await api(
    `/rest/v1/audit_logs?select=action,after_data&business_id=eq.${businessId}` +
      `&action=eq.import.withdrawn&order=created_at.desc&limit=1`
  )) as { action: string; after_data: Record<string, unknown> }[]
  check("IT IS IN THE AUDIT LOG, WITH THE COUNTS AND THE REASON",
    auditRows.length === 1 && auditRows[0].after_data.orders_withdrawn === 1 &&
      auditRows[0].after_data.records_left_shared === 1 &&
      auditRows[0].after_data.reason === "Wrong file",
    JSON.stringify(auditRows))

  const overviewAfter = (await rpc("import_batch_overview", { p_limit: 50 })) as Overview[]
  const listedAfter = overviewAfter.find((row) => row.batch_id === batchA)!
  check("the list shows it as withdrawn, with its reason",
    listedAfter.withdrawn_at !== null && listedAfter.withdrawal_reason === "Wrong file" &&
      listedAfter.records_withdrawn === 1,
    JSON.stringify(listedAfter))

  const twice = await tryRpc("import_batch_withdraw", { p_batch_id: batchA })
  check("withdrawing it a second time is refused",
    !twice.ok && JSON.stringify(twice.body).includes("already been withdrawn"),
    JSON.stringify(twice.body))

  /* ---------------------------------------------------------------------- */
  section("5. THE SHARED ORDER NOW BELONGS TO FILE B ALONE")

  const [previewBNow] = (await rpc("import_batch_withdrawal_preview", {
    p_batch_id: batchB,
  })) as Preview[]
  check("with file A withdrawn, B's record is no longer shared",
    previewBNow.records_exclusive === 1 && previewBNow.records_shared === 0,
    JSON.stringify(previewBNow))
  check("so withdrawing B would now take the whole business's remaining revenue out",
    previewBNow.orders_exclusive === 1)

  /* ---------------------------------------------------------------------- */
  section("6. PUTTING IT BACK")

  const staffRestore = await tryRpc("import_batch_restore", { p_batch_id: batchA }, otherToken)
  check("a staff member cannot restore it either", !staffRestore.ok)

  const [restored] = (await rpc("import_batch_restore", { p_batch_id: batchA })) as {
    orders_restored: number
    products_restored: number
    expenses_restored: number
  }[]
  check("restoring brings back exactly the one order it withdrew",
    restored.orders_restored === 1 && restored.products_restored === 0 &&
      restored.expenses_restored === 0, JSON.stringify(restored))

  const [restoredFinancials] = await rpc("analytics_financials", window)
  check("REVENUE IS BACK TO 1700", eq(restoredFinancials.revenue, 1700),
    String(restoredFinancials.revenue))

  const restoredOrders = (await api(
    `/rest/v1/orders?select=id,withdrawn_at,withdrawn_by_batch&business_id=eq.${businessId}`
  )) as { id: string; withdrawn_at: string | null; withdrawn_by_batch: string | null }[]
  check("no order is left marked",
    restoredOrders.every((row) => row.withdrawn_at === null && row.withdrawn_by_batch === null))

  const restoreAudit = (await api(
    `/rest/v1/audit_logs?select=action&business_id=eq.${businessId}` +
      `&action=eq.import.restored&limit=1`
  )) as { action: string }[]
  check("the restore is audited too", restoreAudit.length === 1)

  const notWithdrawn = await tryRpc("import_batch_restore", { p_batch_id: batchA })
  check("restoring an import that is not withdrawn is refused",
    !notWithdrawn.ok && JSON.stringify(notWithdrawn.body).includes("not withdrawn"),
    JSON.stringify(notWithdrawn.body))

  /* ---------------------------------------------------------------------- */
  section("7. THE WITHDRAWAL MARKERS BELONG TO THE DATABASE, NOT TO A REQUEST")

  // Everything above is reachable only through the four functions. These are
  // the attempts that would go round them.

  const fakeWithdraw = await attempt(`/rest/v1/orders?id=eq.${o1.id}`, {
    method: "PATCH",
    body: JSON.stringify({ withdrawn_at: new Date().toISOString() }),
  })
  check("A REQUEST CANNOT MARK AN ORDER WITHDRAWN BY ITSELF",
    !fakeWithdraw.ok, `${fakeWithdraw.status} ${JSON.stringify(fakeWithdraw.body)}`)

  const fakeUnwithdraw = await attempt(`/rest/v1/orders?id=eq.${o2.id}`, {
    method: "PATCH",
    body: JSON.stringify({ withdrawn_by_batch: batchB }),
  })
  check("nor claim an order for another import",
    !fakeUnwithdraw.ok, `${fakeUnwithdraw.status} ${JSON.stringify(fakeUnwithdraw.body)}`)

  const fakeLineage = await attempt(`/rest/v1/import_batches?id=eq.${batchA}`, {
    method: "PATCH",
    body: JSON.stringify({ lineage_status: "NONE" }),
  })
  check("nor rewrite what BizMind knows about an import's history",
    !fakeLineage.ok, `${fakeLineage.status} ${JSON.stringify(fakeLineage.body)}`)

  const fakeBatchFlag = await attempt(`/rest/v1/import_batches?id=eq.${batchA}`, {
    method: "PATCH",
    body: JSON.stringify({ withdrawn_at: new Date().toISOString(), withdrawal_reason: "hand-set" }),
  })
  check("nor mark an import withdrawn without withdrawing its records",
    !fakeBatchFlag.ok, `${fakeBatchFlag.status} ${JSON.stringify(fakeBatchFlag.body)}`)

  const bornWithdrawn = await attempt("/rest/v1/orders", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      order_number: `BORN-${suffix}`,
      status: "FULFILLED",
      currency: "BDT",
      total: "1.00",
      placed_at: "2026-09-20T10:00:00Z",
      withdrawn_at: new Date().toISOString(),
    }),
  })
  check("and a record cannot be created already withdrawn",
    !bornWithdrawn.ok, `${bornWithdrawn.status} ${JSON.stringify(bornWithdrawn.body)}`)

  const [unchanged] = await rpc("analytics_financials", window)
  check("after every attempt, the figures are exactly where they were",
    eq(unchanged.revenue, 1700), String(unchanged.revenue))

  /* ---------------------------------------------------------------------- */
  section("8. A MISSING IMPORT IS NOT A LEAK")

  const rivalBatch = await api(
    "/rest/v1/import_batches",
    {
      method: "POST",
      body: JSON.stringify({
        business_id: rivalId,
        entity: "ORDERS",
        status: "READY",
        source: "WEBSITE",
        file_name: `rival-${suffix}.csv`,
        file_type: "csv",
        file_size_bytes: 32,
        row_count: 1,
      }),
    },
    otherToken
  )
  const crossPreview = await tryRpc("import_batch_withdrawal_preview", {
    p_batch_id: rivalBatch[0].id,
  })
  check("previewing another business's import is refused",
    !crossPreview.ok, `${crossPreview.status} ${JSON.stringify(crossPreview.body)}`)

  const missing = await tryRpc("import_batch_withdrawal_preview", {
    p_batch_id: "00000000-0000-0000-0000-000000000000",
  })
  check("an import that does not exist is refused the same way",
    !missing.ok && JSON.stringify(missing.body).includes("could not be found"),
    JSON.stringify(missing.body))
  check("AND THE TWO ARE INDISTINGUISHABLE, so a refusal cannot confirm that " +
    "another business's import exists",
    JSON.stringify(crossPreview.body) === JSON.stringify(missing.body),
    `${JSON.stringify(crossPreview.body)} vs ${JSON.stringify(missing.body)}`)
} finally {
  console.log(`\n${"=".repeat(74)}`)
  console.log(` ${passed} passed, ${failed} failed`)
  console.log(`${"=".repeat(74)}`)
  console.log(
    `\n  Tenants left behind for inspection:\n    ${businessId}\n    ${rivalId}\n`
  )
}

process.exit(failed === 0 ? 0 : 1)
