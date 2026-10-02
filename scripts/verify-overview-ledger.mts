/**
 * The home dashboard's readers, end to end against the real database
 * (migration 0043).
 *
 * Run with:  npm run test:overview-ledger
 *
 * An INVENTED fixture, in a throwaway business:
 *   Amazon.ae (AED)   June: sales 200, fees -20
 *                     July: two settlements, sales 100 + 50, fees -10 + -10
 *                           (the second one's reported total does not add up)
 *   Amazon.ae 2 (AED) July: sales 80, fees -8
 *   Amazon.sa (SAR)   no data -- present only to prove currencies never mix
 *
 * The dashboard readers must agree with the P&L engine they build on, place
 * every bar on one 0-1000 scale, compare against the calendar month before,
 * keep net profit to the whole currency, never call an expected payout
 * received, and show another business nothing.
 */

import { createHash } from "node:crypto"

import { requireConfig } from "./test-env.mjs"
import { parseFile } from "../src/services/ingestion/parse"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
import { AMAZON_V2_HEADERS } from "../src/services/marketplaces/amazon/flat-file-v2"
import type { MappingRuleSummary, SourceRow } from "../src/services/marketplaces/contract"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"

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

/** Exact 4-place decimal text -> integer ten-thousandths, for test arithmetic only. */
const units = (value: string | null | undefined): bigint => {
  if (value === null || value === undefined) return BigInt(0)
  const negative = value.startsWith("-")
  const [whole, fraction = ""] = value.replace("-", "").split(".")
  const n = BigInt(whole) * BigInt(10000) + BigInt((fraction + "0000").slice(0, 4))
  return negative ? -n : n
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(`Could not sign in as ${email}`)
  return (await response.json()).access_token
}

/* ---- invented reports -------------------------------------------------------- */

const RUN = Date.now().toString().slice(-9)
const SID = (n: number) => `8${n}${RUN}`

const tsv = (fields: Partial<Record<(typeof AMAZON_V2_HEADERS)[number], string>>) =>
  AMAZON_V2_HEADERS.map((header) => fields[header] ?? "").join("\t")

function settlement(sid: string, month: "06" | "07", total: string, lines: [string, string, string][]): string {
  return [
    AMAZON_V2_HEADERS.join("\t"),
    tsv({ "settlement-id": sid, "settlement-start-date": `01.${month}.2026 00:00:00 UTC`,
      "settlement-end-date": `14.${month}.2026 00:00:00 UTC`, "deposit-date": `18.${month}.2026 00:00:00 UTC`,
      "total-amount": total, currency: "AED" }),
    ...lines.map(([description, amountType, amount], i) => tsv({
      "settlement-id": sid, "transaction-type": "Order", "order-id": `998-${sid}-${i}`,
      "merchant-order-id": `998-${sid}-${i}`, "marketplace-name": "Amazon.ae", "amount-type": amountType,
      "amount-description": description, amount, "fulfillment-id": "AFN", "posted-date": `05.${month}.2026`,
      "posted-date-time": `05.${month}.2026 10:00:00 UTC`, "order-item-code": `6${sid}`, sku: "OVERVIEW-SKU",
      "quantity-purchased": "1",
    })),
  ].join("\n") + "\n"
}

const JUNE = settlement(SID(1), "06", "180.00", [["Principal", "ItemPrice", "200.00"], ["Commission", "ItemFees", "-20.00"]])
const JULY_A = settlement(SID(2), "07", "90.00", [["Principal", "ItemPrice", "100.00"], ["Commission", "ItemFees", "-10.00"]])
// Reported total 50, lines add up to 40: an expected payout in doubt.
const JULY_B = settlement(SID(3), "07", "50.00", [["Principal", "ItemPrice", "50.00"], ["Commission", "ItemFees", "-10.00"]])
const JULY_C = settlement(SID(4), "07", "72.00", [["Principal", "ItemPrice", "80.00"], ["Commission", "ItemFees", "-8.00"]])

/* ---- setup ------------------------------------------------------------------ */

section("Setup -- a throwaway business with two AED accounts and one SAR account")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)

const created = await rpc("create_business", { p_name: `Overview Verify ${suffix}`, p_slug: `overview-verify-${suffix}`, p_currency: "AED" }, owner)
if (!created.ok) {
  console.log(`  could not create the business: ${say(created)}`)
  process.exit(1)
}
const businessId: string = created.body.id

async function upload(accountId: string, name: string, content: string): Promise<Reply> {
  const buffer = Buffer.from(content, "utf8")
  const parsed = await parseFile(buffer, name)
  if ("error" in parsed) throw new Error(parsed.error)
  const detection = marketplaceAdapters.detect({ fileName: name, headers: parsed.columns, rows: [] })
  if (detection.kind !== "match") throw new Error(`${name}: not recognised`)
  const ruleRows = rows(await read(
    `/rest/v1/ledger_mapping_rules?select=id,match_key,side,category,subcategory,attribution,quantity_rule,sign_rule&marketplace_code=eq.AMAZON&format_id=eq.${detection.format.id}&status=eq.ACTIVE`,
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
    formatId: detection.format.id, rows: sourceRows, rules, account: { id: accountId, marketplaceCode: "AMAZON", currency: "AED" },
  })
  const built = buildLedgerFilePayload({
    accountId, accountCurrency: "AED", format: detection.format,
    file: { name, type: "txt", sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") },
    columns: parsed.columns, rows: sourceRows, result,
  })
  if (!built.ok) throw new Error(`${name}: ${built.problems.join(" | ")}`)
  return rpc("ledger_apply_file", { p_file: built.payload }, owner)
}

try {
  const makeAccount = async (label: string, country: string, currency: string, sellerRef?: string) => {
    const reply = await rpc("marketplace_account_create", {
      p_business_id: businessId, p_marketplace_code: "AMAZON", p_label: label, p_country: country, p_currency: currency,
      p_external_seller_ref: sellerRef ?? null,
    }, owner)
    if (!reply.ok) throw new Error(`Could not create ${label}: ${say(reply)}`)
    return reply.body as string
  }
  const amazon = await makeAccount("Amazon.ae", "AE", "AED")
  const amazon2 = await makeAccount("Amazon.ae 2", "AE", "AED", `SECOND-${RUN}`)
  const saudi = await makeAccount("Amazon.sa", "SA", "SAR")

  const uploads = [
    await upload(amazon, `${SID(1)}.txt`, JUNE),
    await upload(amazon, `${SID(2)}.txt`, JULY_A),
    await upload(amazon, `${SID(3)}.txt`, JULY_B),
    await upload(amazon2, `${SID(4)}.txt`, JULY_C),
  ]
  check("the fixture is recorded (four invented settlements)", uploads.every((r) => r.ok),
    uploads.filter((r) => !r.ok).map(say).join(" | "))

  const JULY = { p_business_id: businessId, p_currency: "AED", p_from: "2026-07-01T00:00:00Z", p_to: "2026-08-01T00:00:00Z" }
  const JULY_RANGE = { p_business_id: businessId, p_from: JULY.p_from, p_to: JULY.p_to }

  /* ------------------------------------------------------------------------ */
  section("1. THE HEADLINE FIGURES AGREE WITH THE P&L ENGINE")

  const all = rows(await rpc("dashboard_overview", JULY, owner))[0]
  const engineAll = rows(await rpc("pnl_summary", { ...JULY_RANGE, p_combine_by_currency: true }, owner)).find((r) => r.currency === "AED")
  check("one row for all AED accounts, with both accounts and marketplace data",
    all?.accounts === 2 && all?.has_marketplace_data === true && all?.currency === "AED", JSON.stringify(all)?.slice(0, 300))
  check("gross sales 230.0000, as the engine adds it up",
    all?.gross_sales === "230.0000" && all?.gross_sales === engineAll?.gross_sales, `${all?.gross_sales} vs ${engineAll?.gross_sales}`)
  const sameAsEngine = ["net_sales", "marketplace_fees", "fulfillment", "advertising", "contribution", "contribution_status",
    "gross_profit", "gross_profit_status"].every((k) => all?.[k] === engineAll?.[k])
  check("net sales, fees, contribution and gross profit are the engine's own figures", sameAsEngine,
    JSON.stringify({ all, engineAll }).slice(0, 400))
  check(
    "marketplace costs = fees + fulfilment + advertising + other + non-recoverable VAT (-28.0000)",
    all?.marketplace_costs === "-28.0000" &&
      units(all?.marketplace_costs) ===
        units(all?.marketplace_fees) + units(all?.fulfillment) + units(all?.advertising) +
          units(all?.other_marketplace_costs) + units(all?.non_recoverable_vat),
    all?.marketplace_costs
  )
  check("its share of net sales is worked out in SQL: 12.2% (28 of 230)",
    Number(all?.costs_pct_of_net_sales) === 12.2, String(all?.costs_pct_of_net_sales))
  check("net profit belongs to the whole currency, so it is available here", all?.net_available === true)
  check("expected payouts: three settlements, one in doubt, never received",
    all?.expected_payouts === 3 && all?.payouts_in_doubt === 1 && all?.expected_inflow === "212.0000",
    JSON.stringify([all?.expected_payouts, all?.payouts_in_doubt, all?.expected_inflow]))

  const one = rows(await rpc("dashboard_overview", { ...JULY, p_account_id: amazon }, owner))[0]
  const engineOne = rows(await rpc("pnl_summary", { p_from: JULY.p_from, p_to: JULY.p_to, p_account_id: amazon }, owner))[0]
  check("one account: gross sales 150.0000, as the engine says",
    one?.accounts === 1 && one?.gross_sales === "150.0000" && one?.gross_sales === engineOne?.gross_sales,
    `${one?.gross_sales} vs ${engineOne?.gross_sales}`)
  check("an account that shares its currency shows no net profit (expenses are never allocated)",
    one?.net_available === false && one?.net_profit === null)

  const alone = rows(await rpc("dashboard_overview", { ...JULY, p_currency: "SAR", p_account_id: saudi }, owner))[0]
  check("an account alone in its currency may show net profit; with no data it says so",
    alone?.net_available === true && alone?.has_marketplace_data === false && alone?.gross_sales === null,
    JSON.stringify(alone)?.slice(0, 300))

  const wrong = await rpc("dashboard_overview", { ...JULY, p_currency: "SAR", p_account_id: amazon }, owner)
  check("an account asked for in another currency is refused, never converted",
    !wrong.ok || rows(wrong)[0]?.accounts === 0 || rows(wrong).length === 0, say(wrong))

  /* ------------------------------------------------------------------------ */
  section("2. AGAINST LAST MONTH")

  check("the account's previous calendar month (June) has data", one?.prev_has_marketplace_data === true)
  check("gross sales fell 25.0% (200 -> 150), worked out in SQL",
    Number(one?.gross_sales_change_pct) === -25, String(one?.gross_sales_change_pct))
  check("the second account had no June, so it has nothing to compare",
    rows(await rpc("dashboard_overview", { ...JULY, p_account_id: amazon2 }, owner))[0]?.gross_sales_change_pct === null)
  const june = rows(await rpc("dashboard_overview", {
    ...JULY, p_from: "2026-06-01T00:00:00Z", p_to: "2026-07-01T00:00:00Z",
  }, owner))[0]
  check("June itself compares with May, which has nothing", june?.prev_has_marketplace_data === false && june?.gross_sales_change_pct === null)
  const pctReply = await rpc("dashboard_pct", { p_part: -25, p_whole: 200 }, owner)
  const pctZero = await rpc("dashboard_pct", { p_part: 5, p_whole: 0 }, owner)
  check("a share of a negative whole keeps its sign; a share of zero is no share",
    Number(pctReply.body) === -12.5 && pctZero.body === null, `${say(pctReply)} ${say(pctZero)}`)

  /* ------------------------------------------------------------------------ */
  section("2b. THE PROFIT BRIDGE READS THE OVERVIEW ROW, NOT THE LEDGER AGAIN (0064)")

  const juneOne = rows(await rpc("dashboard_overview", {
    ...JULY, p_from: "2026-06-01T00:00:00Z", p_to: "2026-07-01T00:00:00Z", p_account_id: amazon,
  }, owner))[0]
  const bridgeOne = rows(await rpc("dashboard_profit_bridge", { p_overview: one }, owner))
  check("dashboard_profit_bridge takes the overview row as jsonb and returns steps",
    bridgeOne.length > 0, JSON.stringify(bridgeOne).slice(0, 300))
  check("its first step is the previous period's own contribution, read from prev_snapshot -- not recomputed",
    bridgeOne[0]?.kind === "START" && bridgeOne[0]?.amount === juneOne?.contribution_before_open_items,
    `${bridgeOne[0]?.amount} vs ${juneOne?.contribution_before_open_items}`)
  check("its last step is the current period's own contribution, read straight off the overview row",
    bridgeOne[bridgeOne.length - 1]?.kind === "END" &&
      bridgeOne[bridgeOne.length - 1]?.amount === one?.contribution_before_open_items,
    `${bridgeOne[bridgeOne.length - 1]?.amount} vs ${one?.contribution_before_open_items}`)
  const bridgeSum = bridgeOne.reduce((total, step, index) => {
    if (index === 0 || index === bridgeOne.length - 1) return total
    return total + units(step.amount as string)
  }, units(bridgeOne[0]?.amount as string))
  check("the steps reconcile exactly: previous contribution + every delta = current contribution",
    bridgeSum === units(bridgeOne[bridgeOne.length - 1]?.amount as string),
    `${bridgeSum} vs ${units(bridgeOne[bridgeOne.length - 1]?.amount as string)}`)
  const noCompare = rows(await rpc("dashboard_profit_bridge", { p_overview: june }, owner))
  check("a period with no comparison (June itself has no May) yields no bridge steps, not a guess",
    noCompare.length === 0, JSON.stringify(noCompare).slice(0, 200))

  /* ------------------------------------------------------------------------ */
  section("3. THE WATERFALL")

  const steps = rows(await rpc("dashboard_waterfall", JULY, owner))
  const step = (label: string) => steps.find((s) => s.label === label)
  check("it starts at gross sales and passes through net sales and contribution",
    step("Gross sales")?.kind === "TOTAL" && step("Gross sales")?.amount === all?.gross_sales &&
      step("Net sales")?.amount === all?.net_sales && step("Contribution")?.kind === "TOTAL",
    JSON.stringify(steps.map((s) => [s.label, s.kind, s.amount])))
  check("the contribution bar carries the contribution's own status",
    step("Contribution")?.status === all?.contribution_status)
  check("optional steps with nothing in them are left out (no seller discounts, no other income)",
    !step("Seller discounts") && !step("Other income"))
  check("core steps stay even at zero, so a month with no refunds says so",
    step("Refunds")?.amount === "0.0000", JSON.stringify(step("Refunds")))
  check("every bar sits on one 0-1000 scale, with one zero line",
    steps.every((s) => s.bar_from >= 0 && s.bar_to <= 1000 && s.bar_from <= s.bar_to) &&
      new Set(steps.map((s) => s.zero_at)).size === 1,
    JSON.stringify(steps.map((s) => [s.bar_from, s.bar_to, s.zero_at])))
  check("the tallest bar reaches the top of the scale", Math.max(...steps.map((s) => s.bar_to)) === 1000)
  const deltas = steps.filter((s) => s.kind === "DELTA")
  check("each money-in or money-out step is drawn from where the running total stood",
    deltas.every((s) => s.bar_to > s.bar_from || units(s.amount) === BigInt(0)))
  const oneSteps = rows(await rpc("dashboard_waterfall", { ...JULY, p_account_id: amazon }, owner))
  check("for an account that shares its currency, it stops before net profit",
    !oneSteps.some((s) => s.label === "Net profit" || s.label === "Operating expenses"))

  /* ------------------------------------------------------------------------ */
  section("4. DAY BY DAY, COSTS, ACCOUNTS")

  const days = rows(await rpc("dashboard_daily", JULY, owner))
  const fifth = days.find((d) => String(d.day).startsWith("2026-07-05"))
  check("every day of July, even the empty ones (31)", days.length === 31, String(days.length))
  check("5 July holds all 230.0000 of gross sales", fifth?.has_lines === true && fifth?.gross_sales === "230.0000",
    JSON.stringify(fifth))
  check("the busiest day reaches the top of the shared scale", Math.max(...days.map((d) => d.gross_y)) === 1000)
  check("quiet days sit on the zero line",
    days.filter((d) => !d.has_lines).every((d) => d.gross_y === d.zero_y && d.net_y === d.zero_y))

  const costs = rows(await rpc("dashboard_cost_breakdown", JULY, owner))
  check("costs by category add back to the marketplace costs",
    costs.reduce((sum, c) => sum + units(c.total), BigInt(0)) === units(all?.marketplace_costs),
    JSON.stringify(costs))
  check("the largest cost has the full bar", costs.length > 0 && costs[0].bar === 1000, JSON.stringify(costs[0]))

  const accounts = rows(await rpc("dashboard_accounts", { p_business_id: businessId, p_currency: "AED", p_from: JULY.p_from, p_to: JULY.p_to }, owner))
  check("both AED accounts, and never the SAR one", accounts.length === 2 && !accounts.some((a) => a.marketplace_account_id === saudi),
    JSON.stringify(accounts.map((a) => a.account_label)))
  const acct = (id: string) => accounts.find((a) => a.marketplace_account_id === id)
  check("each account's net sales agree with the overview for that account",
    acct(amazon)?.net_sales === one?.net_sales && acct(amazon)?.expected_payouts === 2)
  check("shares of net sales are the database's: 65.2% and 34.8% of 230",
    Number(acct(amazon)?.share_of_net_sales_pct) === 65.2 && Number(acct(amazon2)?.share_of_net_sales_pct) === 34.8,
    JSON.stringify(accounts.map((a) => [a.account_label, a.net_sales, a.share_of_net_sales_pct])))
  // 0051: accounts are worked out from line types; every figure must be the
  // P&L engine's own per-account summary.
  const perAccount = rows(await rpc("pnl_summary", { p_from: JULY.p_from, p_to: JULY.p_to, p_business_id: businessId }, owner))
  for (const id of [amazon, amazon2]) {
    const e = perAccount.find((r) => r.marketplace_account_id === id)
    const a = acct(id)
    const costs = e && units(e.marketplace_fees) + units(e.fulfillment) + units(e.advertising) +
      units(e.other_marketplace_costs) + units(e.non_recoverable_vat)
    check(`${a?.account_label}: gross, net, costs, contribution and status are pnl_summary()'s own`,
      a?.gross_sales === e?.gross_sales && a?.net_sales === e?.net_sales && units(a?.marketplace_costs) === costs &&
        a?.advertising === e?.advertising && a?.contribution === e?.contribution &&
        a?.contribution_before_open_items === e?.contribution_before_open_items &&
        a?.contribution_status === e?.contribution_status,
      JSON.stringify({ a, e: e && [e.gross_sales, e.net_sales, e.contribution, e.contribution_before_open_items, e.contribution_status] }))
  }
  const costRows = rows(await rpc("dashboard_cost_breakdown", JULY, owner))
  check("costs by category still add back to the marketplace costs (0051)",
    costRows.reduce((sum, c) => sum + units(c.total), BigInt(0)) === units(all?.marketplace_costs), JSON.stringify(costRows))
  check("marketplace costs as a share of each account's sales: 13.3% (20 of 150)",
    Number(acct(amazon)?.costs_pct_of_net_sales) === 13.3, String(acct(amazon)?.costs_pct_of_net_sales))

  /* ------------------------------------------------------------------------ */
  section("4b. THE EXECUTIVE VIEW: ANY PERIOD, MONTH BY MONTH (0049)")

  const JUN_JUL = { ...JULY, p_from: "2026-06-01T00:00:00Z", p_to: "2026-08-01T00:00:00Z" }
  const monthly = rows(await rpc("dashboard_monthly", JUN_JUL, owner))
  const cell = (month: string, id: string) => monthly.find((m) => m.month === month && m.marketplace_account_id === id)
  check("one row per month and AED account, never the SAR one (2 months x 2 accounts)",
    monthly.length === 4 && !monthly.some((m) => m.marketplace_account_id === saudi), String(monthly.length))
  check("June: Amazon.ae 200.0000; the second account had no lines",
    cell("2026-06-01", amazon)?.net_sales === "200.0000" && cell("2026-06-01", amazon)?.has_lines === true &&
      cell("2026-06-01", amazon2)?.has_lines === false && cell("2026-06-01", amazon2)?.contribution_status === null,
    JSON.stringify(monthly))
  for (const [month, from, to] of [["2026-06-01", "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"], ["2026-07-01", "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"]]) {
    const engine = rows(await rpc("pnl_summary", { p_from: from, p_to: to, p_business_id: businessId, p_combine_by_currency: true }, owner))
      .find((r) => r.currency === "AED")
    const m = cell(month, amazon)
    check(`${month.slice(0, 7)}: the month's net sales, contribution and status are the P&L engine's own`,
      m?.month_net_sales === engine?.net_sales && m?.month_contribution === engine?.contribution_before_open_items &&
        m?.month_status === engine?.contribution_status,
      JSON.stringify({ m, engine: engine && [engine.net_sales, engine.contribution_before_open_items, engine.contribution_status] }))
  }
  check("every bar and point sits on one 0-1000 scale with one zero line",
    monthly.every((m) => m.bar_from >= 0 && m.bar_to <= 1000 && m.bar_from <= m.bar_to && m.month_contribution_y >= 0 &&
      m.month_contribution_y <= 1000) && new Set(monthly.map((m) => m.zero_y)).size === 1)

  const overviewRow = rows(await rpc("dashboard_overview", JULY, owner))[0]
  const fromRow = rows(await rpc("dashboard_waterfall_steps", { p_overview: overviewRow }, owner))
  const direct = rows(await rpc("dashboard_waterfall", JULY, owner))
  check("the waterfall worked out from the overview row equals the full recalculation",
    JSON.stringify(fromRow) === JSON.stringify(direct) && fromRow.length > 0, `${fromRow.length} vs ${direct.length}`)

  // Two months (July-August: only July has data) against the two before (May-June: only June).
  const twoMonths = rows(await rpc("dashboard_overview", { ...JULY, p_to: "2026-09-01T00:00:00Z" }, owner))[0]
  check("a two-month period compares with the two months before it: gross sales +15.0% (230 vs 200)",
    twoMonths?.prev_has_marketplace_data === true && Number(twoMonths?.gross_sales_change_pct) === 15,
    JSON.stringify([twoMonths?.gross_sales, twoMonths?.gross_sales_change_pct]))
  check("a single month still compares with the month before", Number(one?.gross_sales_change_pct) === -25)

  // 0050: net profit is worked out from the summary already read; it must be
  // exactly what pnl_net_profit() says.
  const netEngine = rows(await rpc("pnl_net_profit", { p_from: JULY.p_from, p_to: JULY.p_to, p_business_id: businessId }, owner))
    .find((r) => r.currency === "AED")
  check("the dashboard's net profit, status, reasons and expenses are pnl_net_profit()'s own",
    overviewRow?.net_profit === netEngine?.net_profit && overviewRow?.net_profit_status === netEngine?.net_profit_status &&
      overviewRow?.net_profit_before_open_items === netEngine?.net_profit_before_open_items &&
      JSON.stringify(overviewRow?.net_profit_reasons) === JSON.stringify(netEngine?.net_profit_reasons) &&
      overviewRow?.operating_expenses === netEngine?.operating_expenses,
    JSON.stringify({ dash: [overviewRow?.net_profit, overviewRow?.net_profit_status, overviewRow?.net_profit_before_open_items, overviewRow?.net_profit_reasons, overviewRow?.operating_expenses],
      engine: [netEngine?.net_profit, netEngine?.net_profit_status, netEngine?.net_profit_before_open_items, netEngine?.net_profit_reasons, netEngine?.operating_expenses] }))

  /* ------------------------------------------------------------------------ */
  section("5. ISOLATION")

  for (const fn of ["dashboard_overview", "dashboard_waterfall", "dashboard_daily", "dashboard_cost_breakdown", "dashboard_monthly"]) {
    const reply = await rpc(fn, JULY, rival)
    const got = rows(reply)
    const leaked = fn === "dashboard_overview"
      ? got.some((r) => r.has_marketplace_data || r.gross_sales !== null || r.accounts > 0)
      : fn === "dashboard_daily"
        ? got.some((r) => r.has_lines)
        : got.length > 0
    check(`another business learns nothing from ${fn}, even naming this business`, !leaked, say(reply))
  }
  check("nor from dashboard_accounts",
    rows(await rpc("dashboard_accounts", { p_business_id: businessId, p_currency: "AED", p_from: JULY.p_from, p_to: JULY.p_to }, rival)).length === 0)
  const anon = await request("/rest/v1/rpc/dashboard_overview", { method: "POST", body: JSON.stringify(JULY) }, ANON_KEY)
  check("a signed-out caller cannot read the dashboard", !anon.ok || rows(anon).every((r) => !r.has_marketplace_data), say(anon))
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
