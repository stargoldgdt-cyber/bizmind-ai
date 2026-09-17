/**
 * Alerts on ledger figures, against the real database (migration 0041).
 *
 * Run with:  npm run test:ledger-alerts
 *
 * An INVENTED noon export, dated relative to today so the rolling windows
 * contain it, goes through the real upload path. Rules are then evaluated by
 * the real automation_evaluate_rule(). Proves:
 *   - a final ledger figure crossing its line raises an alert, in its currency
 *   - a figure that is not final is SKIPPED with its reasons, never judged
 *   - a percentage change needs a figure in the window before
 *   - counts are watched by value; another currency with no figures is METRIC_NULL
 *   - a ledger rule must have a currency, a legacy rule must not
 *   - the ledger reader is not callable by people; another business sees nothing
 */

import { createHash } from "node:crypto"

import { requireConfig } from "./test-env.mjs"
import { parseFile } from "../src/services/ingestion/parse"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
import type { MappingRuleSummary, SourceRow } from "../src/services/marketplaces/contract"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import { NOON_TV_HEADERS } from "../src/services/marketplaces/noon/transaction-view"
import { explainSkip } from "../src/services/automation/contracts"

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

type Json = ReturnType<typeof JSON.parse>
type Reply = { ok: boolean; status: number; body: Json }

async function request(path: string, init: RequestInit, token: string): Promise<Reply> {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
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

/* ---- an invented noon export, dated relative to today ---------------------- */

const RUN = Date.now().toString(36).toUpperCase()
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
const TV_MONEY = new Set([
  "Net Proceeds", "Referral Fee including VAT", "Fullfilment & Logistics Fees including VAT",
  "Shipping Credits including VAT", "Other Order Fees including VAT", "Order Subsidies including VAT",
  "Non-Order Fees including VAT", "Non-Order Subsidies including VAT", "Others including VAT", "Total",
])
const csvLine = (values: string[]) => values.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")
const ae = { Contract: `MP${RUN}AE`, "Contract Title": "NOON-AE", Currency: "AED" }
const order = (n: string, date: string) => ({
  ...ae, "Transaction Date": date, "Order Nr": `NAEI${RUN}${n}`, "Item Nr": `NAEI${RUN}${n}-1`, "Partner SKUs": `ALERT-${RUN}`,
  "Transaction Type": "order", "Net Proceeds": "100", "Referral Fee including VAT": "-10", Total: "90",
})
const ads = (date: string, amount: string) => ({
  ...ae, "Transaction Date": date, "Order Nr": "NA", Title: "Advertising Fee", "Transaction Type": "statement_fee",
  "Reference Nr": `PS-${RUN}-${date}`, "Non-Order Fees including VAT": amount, Total: amount,
})
// Last 30 days: sales 100, fees -10, ads -30 -> contribution 60; one payment of 60.
// The 30 days before: sales 100, fees -10, ads -20.
const RECORDS: Record<string, string>[] = [
  order("1", day(10)),
  ads(day(10), "-30"),
  { ...ae, "Transaction Date": day(5), "Order Nr": "NA", Title: "Payment Disbursal", "Transaction Type": "payment",
    "Reference Nr": `${day(5)} ${RUN} Bank Transfer`, "Others including VAT": "-60", Total: "-60" },
  order("2", day(40)),
  ads(day(40), "-20"),
]
const FILE = [
  csvLine([...NOON_TV_HEADERS]),
  ...RECORDS.map((r) => csvLine(NOON_TV_HEADERS.map((h) => r[h] ?? (TV_MONEY.has(h) ? "0" : "")))),
].join("\n") + "\n"

/* ---- setup ------------------------------------------------------------------ */

section("Setup -- a throwaway business with a noon account")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)
const created = await rpc("create_business", { p_name: `Alerts Verify ${suffix}`, p_slug: `alerts-verify-${suffix}`, p_currency: "AED" }, owner)
if (!created.ok) {
  console.log(`  could not create the business: ${say(created)}`)
  process.exit(1)
}
const businessId: string = created.body.id

async function upload(accountId: string): Promise<Reply> {
  const name = `noon-alerts-${RUN}.csv`
  const buffer = Buffer.from(FILE, "utf8")
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

let counter = 0
async function rule(fields: Record<string, unknown>): Promise<Reply> {
  counter += 1
  return request("/rest/v1/automation_rules", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId, name: `Ledger rule ${counter} ${suffix}`, operator: "LT", threshold: 0,
      period_days: 30, severity: "WARNING", cooldown_hours: 0, evaluate_every_minutes: 60,
      suppress_when_incomplete: true, ...fields,
    }),
  }, owner)
}
async function evaluate(ruleReply: Reply): Promise<Json> {
  const id = rows(ruleReply)[0]?.id
  const run = await rpc("automation_evaluate_rule", { p_rule_id: id }, owner)
  return Array.isArray(run.body) ? run.body[0] : run.body
}

try {
  const account = await rpc("marketplace_account_create", {
    p_business_id: businessId, p_marketplace_code: "NOON", p_label: "noon UAE", p_country: "AE", p_currency: "AED",
  }, owner)
  if (!account.ok) throw new Error(say(account))
  await rpc("tax_profile_set_input_vat", { p_account_id: account.body, p_treatment: "NON_RECOVERABLE" }, owner)
  const uploaded = await upload(account.body)
  check("the invented export is recorded", uploaded.ok, say(uploaded))

  /* ------------------------------------------------------------------------ */
  section("1. THE RULE'S CURRENCY")

  const vocabulary = rows(await read("/rest/v1/canonical_metrics?select=key&key=like.ledger_*", owner))
  check("nine ledger metrics are in the vocabulary", vocabulary.length === 9, JSON.stringify(vocabulary))
  const noCurrency = await rule({ metric: "ledger_contribution" })
  check("a ledger rule without a currency is refused", !noCurrency.ok, say(noCurrency))
  const legacyWithCurrency = await rule({ metric: "revenue", ledger_currency: "AED" })
  check("a legacy rule with a currency is refused", !legacyWithCurrency.ok, say(legacyWithCurrency))

  /* ------------------------------------------------------------------------ */
  section("2. EVALUATING")

  const contribution = await rule({ metric: "ledger_contribution", operator: "LT", threshold: 1000, ledger_currency: "AED" })
  const fired = await evaluate(contribution)
  check("final contribution 60 below 1000: FIRED", fired?.status === "FIRED" && fired?.metric_value === "60.0000", JSON.stringify(fired))
  const alert = rows(await read(`/rest/v1/alerts?select=title,body,currency,metric,metric_value&id=eq.${fired?.alert_id}`, owner))[0]
  check("the alert names the figure and its currency, and carries the currency",
    alert?.currency === "AED" && String(alert?.body).startsWith("Contribution (AED) over the last 30 days is 60.0000"),
    JSON.stringify(alert))

  const gross = await evaluate(await rule({ metric: "ledger_gross_profit", operator: "LT", threshold: 1000, ledger_currency: "AED" }))
  check("gross profit is not final (SKU not matched): SKIPPED with the reason",
    gross?.status === "SKIPPED" && String(gross?.skipped_reason).startsWith("INCOMPLETE_DATA:") &&
      String(gross?.skipped_reason).includes("SKU_NOT_MAPPED") && gross?.metric_value === null,
    JSON.stringify(gross))
  check("and the owner is told why in plain words",
    (explainSkip(gross?.skipped_reason ?? null) ?? "").includes("not matched to a product"))
  const netProfit = await evaluate(await rule({ metric: "ledger_net_profit", operator: "LT", threshold: 0, ledger_currency: "AED" }))
  check("net profit is not final either: SKIPPED", netProfit?.status === "SKIPPED" && String(netProfit?.skipped_reason).startsWith("INCOMPLETE_DATA"),
    JSON.stringify(netProfit))

  const adsUp = await evaluate(await rule({
    metric: "ledger_advertising", operator: "CHANGE_PCT_GT", threshold: 20, ledger_currency: "AED",
  }))
  check("advertising 30 against 20 before: up 50.00%, FIRED", adsUp?.status === "FIRED" && adsUp?.metric_value === "50.00",
    JSON.stringify(adsUp))
  const salesUp = await evaluate(await rule({ metric: "ledger_net_sales", operator: "GT", threshold: 150, period_days: 60, ledger_currency: "AED" }))
  check("net sales over 60 days are 200: FIRED", salesUp?.status === "FIRED" && salesUp?.metric_value === "200.0000", JSON.stringify(salesUp))

  const payoutsDown = await evaluate(await rule({
    metric: "ledger_expected_payouts", operator: "CHANGE_PCT_LT", threshold: -10, ledger_currency: "AED",
  }))
  check("expected payouts had nothing in the window before: SKIPPED, no change invented",
    payoutsDown?.status === "SKIPPED" && payoutsDown?.skipped_reason === "NO_PREVIOUS_VALUE", JSON.stringify(payoutsDown))
  const payoutsValue = await evaluate(await rule({ metric: "ledger_expected_payouts", operator: "GTE", threshold: 60, ledger_currency: "AED" }))
  check("expected payouts in the last 30 days are 60: FIRED", payoutsValue?.status === "FIRED" && payoutsValue?.metric_value === "60.0000",
    JSON.stringify(payoutsValue))

  const unknown = await evaluate(await rule({ metric: "ledger_unknown_lines", operator: "GT", threshold: 0, ledger_currency: "AED" }))
  check("no unrecognised lines: NOT_MATCHED", unknown?.status === "NOT_MATCHED" && unknown?.metric_value === "0", JSON.stringify(unknown))
  const mismatched = await evaluate(await rule({ metric: "ledger_settlements_mismatched", operator: "GT", threshold: 0, ledger_currency: "AED" }))
  check("no settlement out of balance: NOT_MATCHED", mismatched?.status === "NOT_MATCHED", JSON.stringify(mismatched))
  const countChange = await evaluate(await rule({
    metric: "ledger_unknown_lines", operator: "CHANGE_PCT_GT", threshold: 10, ledger_currency: "AED",
  }))
  check("a count is never watched for a percentage change", countChange?.status === "SKIPPED" && countChange?.skipped_reason === "NO_COMPARISON",
    JSON.stringify(countChange))
  const otherCurrency = await evaluate(await rule({ metric: "ledger_contribution", operator: "LT", threshold: 1000, ledger_currency: "SAR" }))
  check("another currency with no figures is METRIC_NULL, never zero",
    otherCurrency?.status === "SKIPPED" && otherCurrency?.skipped_reason === "METRIC_NULL", JSON.stringify(otherCurrency))

  /* ------------------------------------------------------------------------ */
  section("3. NOTHING CROSSES BUSINESSES")

  const direct = await rpc("automation_ledger_value", {
    p_business_id: businessId, p_metric: "ledger_net_sales", p_currency: "AED",
    p_from: day(30), p_to: day(0), p_suppress: false,
  }, rival)
  check("the ledger reader cannot be called by a person", !direct.ok, say(direct))
  const ownDirect = await rpc("automation_ledger_value", {
    p_business_id: businessId, p_metric: "ledger_net_sales", p_currency: "AED",
    p_from: day(30), p_to: day(0), p_suppress: false,
  }, owner)
  check("not even by the owner", !ownDirect.ok, say(ownDirect))
  const rivalEvaluate = await rpc("automation_evaluate_rule", { p_rule_id: rows(contribution)[0]?.id }, rival)
  check("another business's user cannot evaluate this business's rule", !rivalEvaluate.ok, say(rivalEvaluate))
  check("nor see its alerts", rows(await read(`/rest/v1/alerts?select=id&business_id=eq.${businessId}`, rival)).length === 0)
} catch (error) {
  failed += 1
  console.log(`\n  FAIL  the suite stopped early: ${(error as Error).message}`)
} finally {
  const removed = await request(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" }, owner)
  check("the throwaway business is deleted", removed.ok, removed.ok ? "" : say(removed))

  console.log(`\n${"=".repeat(74)}`)
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log("=".repeat(74))
}

process.exit(failed === 0 ? 0 : 1)
