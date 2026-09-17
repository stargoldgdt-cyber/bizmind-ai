/**
 * Operating expenses, Net Profit and product data from Google Sheets, end to
 * end against the real database (migrations 0036-0037).
 *
 * Run with:  npm run test:expenses-ledger
 *
 * An INVENTED noon export goes through the real upload path, and invented
 * spreadsheet pages go through the REAL sync worker (only Google is absent,
 * as in npm run test:integration-live). Then:
 *   - a product-master tab adds and updates products, never duplicates them
 *   - a product-cost tab adds dated costs, replaces a changed one (withdrawn,
 *     never edited), and its sync cannot be "withdrawn" like an old import
 *   - synced expenses are classified automatically; an unknown category keeps
 *     Net Profit incomplete until the owner places it; the business's own word
 *     wins over BizMind's
 *   - Net Profit = Gross Profit - operating expenses - outside advertising
 *   - another business sees nothing; the dataset writers are worker-only
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY (the worker's key), like the Sheets suite.
 */

import { createHash } from "node:crypto"

import { requireConfig, SUPABASE_SERVICE_ROLE_KEY } from "./test-env.mjs"
import { parseFile } from "../src/services/ingestion/parse"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
import type { MappingRuleSummary, SourceRow } from "../src/services/marketplaces/contract"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import { NOON_TV_HEADERS } from "../src/services/marketplaces/noon/transaction-view"

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

const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY ?? ""
if (SERVICE_KEY.length < 20) {
  console.log("  SKIP  SUPABASE_SERVICE_ROLE_KEY is not set; the sync worker cannot be exercised.")
  process.exit(1)
}
// The worker reads its configuration from the environment, as it does in the app.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY ??= SERVICE_KEY

type Json = ReturnType<typeof JSON.parse>
type Reply = { ok: boolean; status: number; body: Json }

async function request(path: string, init: RequestInit, token: string, apikey = ANON_KEY): Promise<Reply> {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: Json = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: response.ok, status: response.status, body }
}

const rpc = (fn: string, args: unknown, token: string) =>
  request(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, token)
const service = (fn: string, args: unknown) =>
  request(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, SERVICE_KEY, SERVICE_KEY)
const read = (path: string, token: string) => request(path, { method: "GET" }, token)
const rows = (reply: Reply): Json[] => (Array.isArray(reply.body) ? reply.body : [])
const say = (reply: Reply) => `${reply.status} ${JSON.stringify(reply.body).slice(0, 300)}`

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(`Could not sign in as ${email}`)
  return (await response.json()).access_token
}

/* ---- an invented noon export: contribution 70.00, one unit ---------------- */

const RUN = Date.now().toString(36).toUpperCase()
const SKU = `NP-${RUN}`
const TV_MONEY = new Set([
  "Net Proceeds", "Referral Fee including VAT", "Fullfilment & Logistics Fees including VAT",
  "Shipping Credits including VAT", "Other Order Fees including VAT", "Order Subsidies including VAT",
  "Non-Order Fees including VAT", "Non-Order Subsidies including VAT", "Others including VAT", "Total",
])
const csvLine = (values: string[]) => values.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")
const ae = { Contract: `MP${RUN}AE`, "Contract Title": "NOON-AE", Currency: "AED" }
const NOON_RECORDS: Record<string, string>[] = [
  { ...ae, "Transaction Date": "2026-07-04", "Order Nr": `NAEI${RUN}1`, "Item Nr": `NAEI${RUN}1-1`, "Partner SKUs": SKU,
    "Transaction Type": "order", "Net Proceeds": "100", "Referral Fee including VAT": "-10", Total: "90" },
  { ...ae, "Transaction Date": "2026-07-08", "Order Nr": "NA", Title: "Advertising Fee", "Transaction Type": "statement_fee",
    "Reference Nr": `PS-${RUN}-AE20260708`, "Non-Order Fees including VAT": "-20", Total: "-20" },
]
const NOON_FILE = [
  csvLine([...NOON_TV_HEADERS]),
  ...NOON_RECORDS.map((r) => csvLine(NOON_TV_HEADERS.map((h) => r[h] ?? (TV_MONEY.has(h) ? "0" : "")))),
].join("\n") + "\n"

/* ---- setup ------------------------------------------------------------------ */

section("Setup -- a throwaway business with a noon account and Google connected")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)

const created = await rpc("create_business", { p_name: `Expenses Verify ${suffix}`, p_slug: `expenses-verify-${suffix}`, p_currency: "AED" }, owner)
if (!created.ok) {
  console.log(`  could not create the business: ${say(created)}`)
  process.exit(1)
}
const businessId: string = created.body.id

const { applyTabularPage } = await import("../src/services/integrations/sync/worker")
type SheetJob = import("../src/services/integrations/sync/worker").JobRow
type SheetContext = import("../src/services/integrations/sync/worker").ContextRow

const JULY = { p_from: "2026-07-01T00:00:00Z", p_to: "2026-08-01T00:00:00Z", p_business_id: businessId }
const AUGUST = { p_from: "2026-08-01T00:00:00Z", p_to: "2026-09-01T00:00:00Z", p_business_id: businessId }
const net = async (period = JULY) => rows(await rpc("pnl_net_profit", period, owner)).find((r) => r.currency === "AED")

async function uploadNoon(accountId: string): Promise<Reply> {
  const name = `noon-tv-${RUN}.csv`
  const buffer = Buffer.from(NOON_FILE, "utf8")
  const parsed = await parseFile(buffer, name)
  if ("error" in parsed) throw new Error(parsed.error)
  const detection = marketplaceAdapters.detect({ fileName: name, headers: parsed.columns, rows: [] })
  if (detection.kind !== "match") throw new Error("the noon export was not recognised")
  const ruleRows = rows(await read(
    `/rest/v1/ledger_mapping_rules?select=id,match_key,side,category,subcategory,attribution,quantity_rule,sign_rule&marketplace_code=eq.NOON&format_id=eq.${detection.format.id}&status=eq.ACTIVE`,
    owner
  ))
  const rules: MappingRuleSummary[] = ruleRows.map((r) => ({
    id: r.id, matchKey: r.match_key, side: r.side, category: r.category, subcategory: r.subcategory,
    attribution: r.attribution, quantityRule: r.quantity_rule, signRule: r.sign_rule,
  }))
  const sourceRows: SourceRow[] = parsed.rows.map((record, index) => ({
    rowNumber: index + 2,
    raw: Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])),
  }))
  const result = detection.adapter.normalize({
    formatId: detection.format.id, rows: sourceRows, rules, account: { id: accountId, marketplaceCode: "NOON", currency: "AED" },
  })
  const built = buildLedgerFilePayload({
    accountId, accountCurrency: "AED", format: detection.format,
    file: { name, type: "csv", sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") },
    columns: parsed.columns, rows: sourceRows, result,
  })
  if (!built.ok) throw new Error(built.problems.join(" | "))
  return rpc("ledger_apply_file", { p_file: built.payload }, owner)
}

/** Connect a tab of an invented spreadsheet, as the wizard does. */
async function connectTab(entity: string, sheetId: number, mapping: Record<string, string>): Promise<string> {
  const reply = await rpc("integration_account_connect", {
    p_business_id: businessId,
    p_provider: "GOOGLE_SHEETS",
    p_external_account_id: `datasheet-${suffix}-abcdefghij:${sheetId}`,
    p_display_name: `Invented ${entity} tab`,
    p_channel_type: null,
    p_metadata: {
      entity, spreadsheet_id: `datasheet-${suffix}-abcdefghij`, sheet_id: sheetId, mapping,
      date_format: "YMD", decimal_separator: ".",
    },
  }, owner)
  if (!reply.ok || !reply.body?.id) throw new Error(`Could not connect the ${entity} tab: ${say(reply)}`)
  return reply.body.id as string
}

/** Queue, claim, start, then one page through the real worker. */
async function runPage(tabId: string, resource: string, headers: string[], records: Record<string, unknown>[], passId: string) {
  const queued = await rpc("sync_enqueue", { p_account_id: tabId, p_resource: resource, p_mode: "INCREMENTAL" }, owner)
  if (!queued.ok) throw new Error(`Could not queue ${resource}: ${say(queued)}`)
  const claimed = await service("sync_claim_jobs", { p_worker_id: `datasets-${suffix}`, p_limit: 200, p_lease_seconds: 300 })
  const job = rows(claimed).find((j: SheetJob) => j.integration_account_id === tabId) as SheetJob | undefined
  if (!job) throw new Error(`The ${resource} job was not claimed: ${say(claimed)}`)
  const started = await service("sync_run_start", { p_job_id: job.id })
  const runId = (Array.isArray(started.body) ? started.body[0]?.id : started.body?.id) as string | undefined
  const context = rows(await service("sync_job_context", { p_job_id: job.id }))[0] as SheetContext
  const outcome = await applyTabularPage(job, runId, context, {
    kind: "page",
    records,
    nextCursor: JSON.stringify({ v: null, row: null, pv: null, pid: null }),
    hasMore: false,
    table: { headers, rowNumbers: records.map((_, i) => i + 2), passId },
  })
  const run = rows(await read(
    `/rest/v1/sync_runs?select=rows_inserted,rows_updated,rows_unchanged,rows_rejected,error_summary&job_id=eq.${job.id}&order=started_at.desc&limit=1`,
    owner
  ))[0]
  return { outcome: String(outcome), run }
}

const issuesOf = async (tabId: string) => {
  const batches = rows(await read(`/rest/v1/import_batches?select=id&integration_account_id=eq.${tabId}`, owner))
  if (batches.length === 0) return [] as Json[]
  return rows(await read(
    `/rest/v1/import_issues?select=row_number,field,message&batch_id=in.(${batches.map((b) => b.id).join(",")})`,
    owner
  ))
}

try {
  const account = await rpc("marketplace_account_create", {
    p_business_id: businessId, p_marketplace_code: "NOON", p_label: "noon UAE", p_country: "AE", p_currency: "AED",
  }, owner)
  if (!account.ok) throw new Error(`Could not create the account: ${say(account)}`)
  await rpc("tax_profile_set_input_vat", { p_account_id: account.body, p_treatment: "NON_RECOVERABLE" }, owner)
  const uploaded = await uploadNoon(account.body)
  check("the invented noon export is recorded (contribution 70.00)", uploaded.ok, say(uploaded))
  const google = await rpc("integration_google_authorize", { p_business_id: businessId }, owner)
  check("Google is authorised for the business", google.ok, say(google))

  /* ------------------------------------------------------------------------ */
  section("1. A PRODUCT-MASTER TAB")

  const CAT_HEADERS = ["SKU", "Name", "Category"]
  const catalogTab = await connectTab("CATALOG", 1, { sku: "SKU", name: "Name", category: "Category" })
  const cat1 = await runPage(catalogTab, "CATALOG", CAT_HEADERS, [
    { SKU: SKU, Name: "Invented bottle", Category: "Drinkware" },
    { SKU: "", Name: "A row with no SKU" },
  ], `cat-1-${suffix}`)
  const products = async () =>
    rows(await read(`/rest/v1/catalog_products?select=id,name,sku_code,category&business_id=eq.${businessId}&order=name`, owner))
  const afterCat1 = await products()
  check(
    "the product is added; the row without a SKU is reported, not guessed",
    cat1.outcome === "PARTIAL" && afterCat1.length === 1 && afterCat1[0].name === "Invented bottle" &&
      (await issuesOf(catalogTab)).some((i) => i.row_number === 3 && i.field === "sku"),
    `${cat1.outcome} ${JSON.stringify(afterCat1)}`
  )
  const cat2 = await runPage(catalogTab, "CATALOG", CAT_HEADERS, [
    { SKU: SKU, Name: "Invented bottle", Category: "Drinkware" },
  ], `cat-2-${suffix}`)
  check("the same sheet again writes nothing", cat2.run?.rows_unchanged === 1 && cat2.run?.rows_inserted === 0, JSON.stringify(cat2.run))
  await runPage(catalogTab, "CATALOG", CAT_HEADERS, [
    { SKU: SKU.toLowerCase(), Name: "Invented bottle 750ml", Category: "Drinkware" },
  ], `cat-3-${suffix}`)
  const afterCat3 = await products()
  check(
    "a renamed row updates the same product (SKU matched ignoring case), never a second one",
    afterCat3.length === 1 && afterCat3[0].name === "Invented bottle 750ml",
    JSON.stringify(afterCat3)
  )
  const productId: string = afterCat3[0]?.id
  const alias = await rpc("sku_alias_decide", {
    p_business_id: businessId, p_marketplace_code: "NOON", p_raw_sku: SKU, p_product_id: productId, p_decision: "CONFIRMED",
  }, owner)
  const noCost = await net()
  check(
    "matched by the owner; gross profit waits for a cost",
    alias.ok && noCost?.gross_profit === null && noCost?.net_profit_reasons.includes("COST_MISSING"),
    `${say(alias)} ${JSON.stringify(noCost)}`
  )

  /* ------------------------------------------------------------------------ */
  section("2. A PRODUCT-COST TAB")

  const COST_HEADERS = ["SKU", "Cost", "From"]
  const costTab = await connectTab("PRODUCT_COSTS", 2, { sku: "SKU", unit_cost: "Cost", effective_from: "From" })
  const cost1 = await runPage(costTab, "PRODUCT_COSTS", COST_HEADERS, [
    { SKU: SKU, Cost: "30", From: "2026-07-01" },
    { SKU: `NEW-${RUN}`, Cost: "5" },
    { SKU: `BAD-${RUN}`, Cost: "1.23456", From: "2026-07-01" },
  ], `cost-1-${suffix}`)
  const costIssues = await issuesOf(costTab)
  check(
    "a cost with more than 4 decimals is refused, never rounded",
    cost1.outcome === "PARTIAL" && costIssues.some((i) => i.field === "unit_cost" && String(i.message).includes("never rounds")),
    JSON.stringify(costIssues)
  )
  const newProduct = rows(await read(
    `/rest/v1/catalog_products?select=id,name&business_id=eq.${businessId}&sku_code=eq.NEW-${RUN}`, owner
  ))[0]
  const newCost = newProduct
    ? rows(await read(`/rest/v1/product_costs?select=effective_from,source,note&product_id=eq.${newProduct.id}`, owner))[0]
    : null
  const today = new Date().toISOString().slice(0, 10)
  check(
    "an unknown SKU code becomes a product named after it; an undated cost applies from today (B7)",
    newProduct?.name === `NEW-${RUN}` && newCost?.effective_from === today && newCost?.source === "SHEETS",
    `${JSON.stringify(newProduct)} ${JSON.stringify(newCost)}`
  )
  check("the bad row's product is not created", rows(await read(
    `/rest/v1/catalog_products?select=id&business_id=eq.${businessId}&sku_code=eq.BAD-${RUN}`, owner
  )).length === 0)

  const withCost = await net()
  check(
    "gross profit is FINAL: 70.00 - 30.00 = 40.0000",
    withCost?.gross_profit === "40.0000" && withCost?.gross_profit_status === "FINAL",
    JSON.stringify(withCost)
  )

  await runPage(costTab, "PRODUCT_COSTS", COST_HEADERS, [
    { SKU: SKU, Cost: "32.5", From: "2026-07-01" },
    { SKU: `NEW-${RUN}`, Cost: "5" },
  ], `cost-2-${suffix}`)
  const history = rows(await read(
    `/rest/v1/product_costs?select=unit_cost,retired_at,retire_reason,retired_by&product_id=eq.${productId}&order=created_at`, owner
  ))
  check(
    "a changed cost is withdrawn (by no person) and replaced, never edited",
    history.length === 2 && history[0].unit_cost === 30 && history[0].retire_reason === "Changed in the Google Sheet" &&
      history[0].retired_by === null && history[1].unit_cost === 32.5 && history[1].retired_at === null,
    JSON.stringify(history)
  )
  const undatedAgain = rows(await read(`/rest/v1/product_costs?select=id&product_id=eq.${newProduct?.id}`, owner))
  check("an unchanged undated cost adds nothing", undatedAgain.length === 1, String(undatedAgain.length))
  check("gross profit follows: 37.5000", (await net())?.gross_profit === "37.5000")

  const synced = rows(await read(
    `/rest/v1/audit_logs?select=after_data&business_id=eq.${businessId}&action=eq.product_cost.synced&order=created_at.desc&limit=1`,
    owner
  ))[0]
  check(
    "the replacement is in the audit log with the old and new cost",
    synced?.after_data?.costs_replaced === 1 &&
      synced?.after_data?.changes?.some((c: Json) => c.previous_unit_cost === "30.0000" && c.unit_cost === "32.5000"),
    JSON.stringify(synced)
  )

  const costBatch = rows(await read(
    `/rest/v1/import_batches?select=id,entity&integration_account_id=eq.${costTab}&status=eq.COMPLETED&order=created_at.desc&limit=1`,
    owner
  ))[0]
  const withdraw = await rpc("import_batch_withdraw", { p_batch_id: costBatch?.id, p_reason: "Verification" }, owner)
  check(
    "a cost sync cannot be withdrawn like an old import",
    costBatch?.entity === "PRODUCT_COSTS" && !withdraw.ok && say(withdraw).includes("cannot be withdrawn"),
    say(withdraw)
  )

  /* ------------------------------------------------------------------------ */
  section("3. SYNCED EXPENSES, CLASSIFIED AUTOMATICALLY")

  const EXP_HEADERS = ["Date", "Amount", "Category", "Ref"]
  const expenseTab = await connectTab("EXPENSES", 3, { incurred_at: "Date", amount: "Amount", category: "Category", external_id: "Ref" })
  const MISC = `Misc stuff ${RUN}`
  const exp = await runPage(expenseTab, "EXPENSES", EXP_HEADERS, [
    { Date: "2026-07-05", Amount: "10", Category: "Rent", Ref: `R1-${RUN}` },
    { Date: "2026-07-06", Amount: "5", Category: "Facebook Ads", Ref: `R2-${RUN}` },
    { Date: "2026-07-07", Amount: "100", Category: "Stock purchase", Ref: `R3-${RUN}` },
    { Date: "2026-07-08", Amount: "7", Category: "Amazon fees", Ref: `R4-${RUN}` },
    { Date: "2026-07-09", Amount: "3", Category: MISC, Ref: `R5-${RUN}` },
    { Date: "2026-08-10", Amount: "1", Category: "RENT", Ref: `R6-${RUN}` },
  ], `exp-1-${suffix}`)
  check("the existing expense tab still syncs", exp.outcome === "SUCCEEDED" && exp.run?.rows_inserted === 6, JSON.stringify(exp))

  const first = await net()
  check(
    "rent is operating (-10), Facebook ads are outside advertising (-5), stock and Amazon fees are kept out (-107)",
    first?.operating_expenses === "-10.0000" && first?.external_advertising === "-5.0000" && first?.not_in_profit === "-107.0000",
    JSON.stringify(first)
  )
  check(
    "one unknown category keeps net profit INCOMPLETE; the known part is informational 22.5000",
    first?.net_profit === null && first?.net_profit_status === "INCOMPLETE" &&
      JSON.stringify(first?.net_profit_reasons) === JSON.stringify(["EXPENSES_UNCLASSIFIED"]) &&
      first?.unclassified_expense_lines === 1 && first?.net_profit_before_open_items === "22.5000",
    JSON.stringify(first)
  )
  const queue = rows(await rpc("expense_category_queue", { p_business_id: businessId }, owner))
  check(
    "only the unknown name is queued for the owner",
    queue.length === 1 && queue[0].category_name === MISC && queue[0].total === "-3.0000",
    JSON.stringify(queue)
  )

  const rivalClassify = await rpc("expense_category_classify", {
    p_business_id: businessId, p_category_name: MISC, p_category_code: "OTHER_OPERATING",
  }, rival)
  check("another business's user cannot classify it", !rivalClassify.ok, say(rivalClassify))
  const unknownName = await rpc("expense_category_classify", {
    p_business_id: businessId, p_category_name: "Never used", p_category_code: "OTHER_OPERATING",
  }, owner)
  check("a name no expense uses is refused", !unknownName.ok && say(unknownName).includes("No expense"), say(unknownName))
  const badCode = await rpc("expense_category_classify", {
    p_business_id: businessId, p_category_name: MISC, p_category_code: "INVENTED",
  }, owner)
  check("an invented category is refused", !badCode.ok, say(badCode))

  const placed = await rpc("expense_category_classify", {
    p_business_id: businessId, p_category_name: MISC, p_category_code: "OTHER_OPERATING",
  }, owner)
  const second = await net()
  check(
    "placed: net profit is FINAL at 19.5000 (37.50 - 10 - 3 - 5)",
    placed.ok && second?.net_profit === "19.5000" && second?.net_profit_status === "FINAL",
    `${say(placed)} ${JSON.stringify(second)}`
  )

  const ownRent = await rpc("expense_category_classify", {
    p_business_id: businessId, p_category_name: "rent", p_category_code: "OWNER_AND_FINANCING",
  }, owner)
  const third = await net()
  check(
    "the business's own word wins over BizMind's: rent moved out of profit, net 29.5000",
    ownRent.ok && third?.net_profit === "29.5000" && third?.not_in_profit === "-117.0000",
    JSON.stringify(third)
  )
  const undo = await rpc("expense_category_rule_retire", { p_rule_id: ownRent.body }, owner)
  check("undoing it brings BizMind's rule back: net 19.5000", undo.ok && (await net())?.net_profit === "19.5000", say(undo))
  const undoGlobal = await rpc("expense_category_rule_retire", {
    p_rule_id: rows(await read("/rest/v1/expense_category_rules?select=id&business_id=is.null&limit=1", owner))[0]?.id,
  }, owner)
  check("nobody can retire one of BizMind's own rules", !undoGlobal.ok, say(undoGlobal))

  const breakdown = rows(await rpc("expense_breakdown", JULY, owner))
  check(
    "the breakdown lists each category with its class",
    breakdown.some((b) => b.category_code === "RENT" && b.cost_class === "OPERATING" && b.total === "-10.0000") &&
      breakdown.some((b) => b.category_code === "STOCK_PURCHASES" && b.cost_class === "NOT_PROFIT"),
    JSON.stringify(breakdown)
  )

  const august = await net(AUGUST)
  check(
    "a month with expenses but no marketplace figures is never final",
    august?.net_profit === null && august?.net_profit_reasons.includes("NO_MARKETPLACE_DATA") &&
      august?.operating_expenses === "-1.0000",
    JSON.stringify(august)
  )
  const periods = rows(await rpc("expense_periods", { p_business_id: businessId }, owner))
  check("both months are offered", periods.length === 2, JSON.stringify(periods))

  /* ------------------------------------------------------------------------ */
  section("3b. A WITHDRAWN EXPENSE IMPORT NO LONGER COUNTS (migration 0042)")

  const expenseBatch = rows(await read(
    `/rest/v1/import_batches?select=id&integration_account_id=eq.${expenseTab}&entity=eq.EXPENSES&status=eq.COMPLETED&order=created_at.desc&limit=1`,
    owner
  ))[0]
  const withdrawnExpenses = await rpc("import_batch_withdraw", { p_batch_id: expenseBatch?.id, p_reason: "Verification" }, owner)
  check("the owner withdraws the synced expense import", withdrawnExpenses.ok, say(withdrawnExpenses))
  const afterWithdraw = await net()
  check(
    "its expenses leave every figure: net profit is gross profit, 37.5000, and FINAL",
    afterWithdraw?.operating_expenses === "0.0000" && afterWithdraw?.external_advertising === "0.0000" &&
      afterWithdraw?.not_in_profit === "0.0000" && afterWithdraw?.expense_lines === 0 &&
      afterWithdraw?.net_profit === "37.5000" && afterWithdraw?.net_profit_status === "FINAL",
    JSON.stringify(afterWithdraw)
  )
  check("August has no expenses left either", (await net(AUGUST)) === undefined, JSON.stringify(await net(AUGUST)))
  check("no expense month or unplaced category is offered",
    rows(await rpc("expense_periods", { p_business_id: businessId }, owner)).length === 0 &&
      rows(await rpc("expense_category_queue", { p_business_id: businessId }, owner)).length === 0)
  const onlyWithdrawn = await rpc("expense_category_classify", {
    p_business_id: businessId, p_category_name: "Rent", p_category_code: "OFFICE",
  }, owner)
  check("a category used only by withdrawn expenses cannot be classified",
    !onlyWithdrawn.ok && say(onlyWithdrawn).includes("No expense"), say(onlyWithdrawn))
  const stillStored = rows(await read(`/rest/v1/expenses?select=id,withdrawn_at&business_id=eq.${businessId}`, owner))
  check("the withdrawn expenses are kept for the record, not deleted",
    stillStored.length === 6 && stillStored.every((e) => e.withdrawn_at !== null), JSON.stringify(stillStored.length))

  /* ------------------------------------------------------------------------ */
  section("4. NOTHING CROSSES BUSINESSES")

  check("another business sees no net profit", rows(await rpc("pnl_net_profit", JULY, rival)).length === 0)
  check("nor its expenses", rows(await read(`/rest/v1/expense_lines?select=id&business_id=eq.${businessId}`, rival)).length === 0)
  check(
    "nor its classifications (BizMind's own rules are shared reference data)",
    rows(await read(`/rest/v1/expense_category_rules?select=id&business_id=eq.${businessId}`, rival)).length === 0 &&
      rows(await read("/rest/v1/expense_category_rules?select=id&business_id=is.null&limit=1", rival)).length === 1
  )
  const signedInWriter = await rpc("sync_apply_product_costs", { p_job_id: costTab, p_rows: [] }, owner)
  check("a signed-in user cannot call the dataset writers", !signedInWriter.ok, say(signedInWriter))
  const directRule = await request("/rest/v1/expense_category_rules", {
    method: "POST", body: JSON.stringify({ business_id: businessId, match_key: "x", category_code: "RENT" }),
  }, owner)
  check("nor write a rule directly", !directRule.ok, say(directRule))
} catch (error) {
  failed += 1
  console.log(`\n  FAIL  the suite stopped early: ${(error as Error).message}`)
} finally {
  const removed = await request(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" }, owner)
  check("the throwaway business is deleted, with its expenses, rules and costs", removed.ok, removed.ok ? "" : say(removed))

  console.log(`\n${"=".repeat(74)}`)
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log("=".repeat(74))
}

process.exit(failed === 0 ? 0 : 1)
