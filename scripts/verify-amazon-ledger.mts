/**
 * Amazon Flat File V2, end to end against the real database (migration 0031).
 *
 * Run with:  npm run test:amazon-ledger
 *
 * An INVENTED settlement file (the real report's shape, no real data) goes
 * through the same steps as an upload: the real parser, the real adapter, the
 * real payload builder, the real seeded rules, ledger_apply_file(). Then the
 * Data Sources readers are checked against what was written.
 */

import { createHash } from "node:crypto"

import { requireConfig } from "./test-env.mjs"
import { parseFile } from "../src/services/ingestion/parse"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
import type { MappingRuleSummary, SourceRow } from "../src/services/marketplaces/contract"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import { AMAZON_V2_HEADERS } from "../src/services/marketplaces/amazon/flat-file-v2"

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
const say = (reply: Reply) => `${reply.status} ${JSON.stringify(reply.body).slice(0, 240)}`

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(`Could not sign in as ${email}`)
  return (await response.json()).access_token
}

/* ---- an invented settlement ---------------------------------------------- */

const SID = `7${Date.now().toString().slice(-10)}`

function tsv(fields: Partial<Record<(typeof AMAZON_V2_HEADERS)[number], string>>): string {
  return AMAZON_V2_HEADERS.map((header) => fields[header] ?? "").join("\t")
}

const orderLine = (description: string, amountType: string, amount: string, extra: Record<string, string> = {}) =>
  tsv({
    "settlement-id": SID, "transaction-type": "Order", "order-id": "999-1111111-1111111",
    "merchant-order-id": "999-1111111-1111111", "marketplace-name": "Amazon.ae", "amount-type": amountType,
    "amount-description": description, amount, "fulfillment-id": "AFN", "posted-date": "04.07.2026",
    "posted-date-time": "04.07.2026 11:00:00 UTC", "order-item-code": "22222222222222", sku: "INVENTED-SKU",
    "quantity-purchased": "3", ...extra,
  })

// Lines: 300.00 + 15.00 - 36.00 - 27.00 + 10.00 - 10.00 - 100.00 + 12.00 - 40.00 - 50.00 - 2.50 + 0.00 - 5.00 = 66.50
const content = [
  AMAZON_V2_HEADERS.join("\t"),
  tsv({ "settlement-id": SID, "settlement-start-date": "02.07.2026 18:27:57 UTC", "settlement-end-date": "16.07.2026 18:27:57 UTC", "deposit-date": "18.07.2026 18:27:57 UTC", "total-amount": "66.50", currency: "AED" }),
  orderLine("Principal", "ItemPrice", "300.00"),
  orderLine("Shipping", "ItemPrice", "15.00"),
  orderLine("Commission", "ItemFees", "-36.00"),
  orderLine("FBAPerUnitFulfillmentFee", "ItemFees", "-27.00"),
  orderLine("COD", "ItemPrice", "10.00"),
  orderLine("CODFee", "ItemFees", "-10.00"),
  tsv({ "settlement-id": SID, "transaction-type": "Refund", "order-id": "999-1111111-1111111", "amount-type": "ItemPrice", "amount-description": "Principal", amount: "-100.00", "posted-date": "06.07.2026", "posted-date-time": "06.07.2026 08:00:00 UTC", "adjustment-id": "33333333333", sku: "INVENTED-SKU" }),
  tsv({ "settlement-id": SID, "transaction-type": "Refund", "order-id": "999-1111111-1111111", "amount-type": "ItemFees", "amount-description": "Commission", amount: "12.00", "posted-date": "06.07.2026", "posted-date-time": "06.07.2026 08:00:00 UTC", sku: "INVENTED-SKU" }),
  tsv({ "settlement-id": SID, "transaction-type": "ServiceFee", "amount-type": "Cost of Advertising", "amount-description": "TransactionTotalAmount", amount: "-40.00", "posted-date": "07.07.2026", "posted-date-time": "07.07.2026 00:00:00 UTC" }),
  tsv({ "settlement-id": SID, "transaction-type": "AmazonFees", "marketplace-name": "Amazon.ae", "amount-type": "Premium Services Fee", "amount-description": "Base fee", amount: "-50.00", "posted-date": "02.07.2026", "posted-date-time": "02.07.2026 12:00:00 UTC" }),
  tsv({ "settlement-id": SID, "transaction-type": "AmazonFees", "marketplace-name": "Amazon.ae", "amount-type": "Premium Services Fee", "amount-description": "Tax on fee", amount: "-2.50", "posted-date": "02.07.2026", "posted-date-time": "02.07.2026 12:00:00 UTC" }),
  tsv({ "settlement-id": SID, "transaction-type": "FBAFees", "marketplace-name": "Amazon.ae", "amount-type": "FBA Inventory Storage Fee", "amount-description": "Base fee", amount: "0.00", "fulfillment-id": "AFN", "posted-date": "07.07.2026", "posted-date-time": "07.07.2026 00:00:00 UTC" }),
  orderLine("InventedFutureFee", "ItemFees", "-5.00"),
].join("\n") + "\n"

/* ---- setup --------------------------------------------------------------- */

section("Setup -- a throwaway business with an Amazon.ae account")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)

const created = await rpc("create_business", { p_name: `Amazon Verify ${suffix}`, p_slug: `amazon-verify-${suffix}`, p_currency: "AED" }, owner)
if (!created.ok) {
  console.log(`  could not create the business: ${say(created)}`)
  process.exit(1)
}
const businessId: string = created.body.id

try {
  const accountReply = await rpc(
    "marketplace_account_create",
    { p_business_id: businessId, p_marketplace_code: "AMAZON", p_label: "Amazon.ae", p_country: "AE", p_currency: "AED" },
    owner
  )
  if (!accountReply.ok) throw new Error(`Could not create the account: ${say(accountReply)}`)
  const accountId: string = accountReply.body

  /* ------------------------------------------------------------------------ */
  section("1. THE SEEDED RULES AND THE MARKETPLACE")

  const marketplace = rows(await read("/rest/v1/marketplaces?select=code,adapter_status&code=eq.AMAZON", owner))[0]
  check("Amazon is now AVAILABLE", marketplace?.adapter_status === "AVAILABLE", JSON.stringify(marketplace))

  const ruleReply = await read(
    "/rest/v1/ledger_mapping_rules?select=id,match_key,side,category,subcategory,attribution,quantity_rule,sign_rule,confidence,evidence&marketplace_code=eq.AMAZON&format_id=eq.amazon.settlement.flat_file_v2&status=eq.ACTIVE",
    owner
  )
  const ruleRows = rows(ruleReply)
  // 21 from 0031, plus the one-line SP 360 fee from 0044.
  check("22 owner-approved rules are active", ruleRows.length === 22, say(ruleReply))
  check(
    "each verified on real settlements and approved by the owner",
    ruleRows.every((rule) => rule.confidence === "SAMPLE_VERIFIED" &&
      (String(rule.evidence).includes("approved by the owner") || String(rule.evidence).includes("Owner decision")))
  )

  const rules: MappingRuleSummary[] = ruleRows.map((rule) => ({
    id: rule.id, matchKey: rule.match_key, side: rule.side, category: rule.category, subcategory: rule.subcategory,
    attribution: rule.attribution, quantityRule: rule.quantity_rule, signRule: rule.sign_rule,
  }))

  /* ------------------------------------------------------------------------ */
  section("2. THE UPLOAD PATH: PARSE, RECOGNISE, ADAPT, BUILD, APPLY")

  const buffer = Buffer.from(content, "utf8")
  const parsed = await parseFile(buffer, `${SID}.txt`)
  if ("error" in parsed) throw new Error(parsed.error)
  check("the tab-separated .txt is read as 24 columns", parsed.columns.length === 24 && parsed.rows.length === 14)

  const detection = marketplaceAdapters.detect({ fileName: `${SID}.txt`, headers: parsed.columns, rows: [] })
  check("it is recognised as Amazon Flat File V2", detection.kind === "match" && detection.format.id === "amazon.settlement.flat_file_v2")
  if (detection.kind !== "match") throw new Error("not recognised")

  const sourceRows: SourceRow[] = parsed.rows.map((record, index) => ({
    rowNumber: index + 2,
    raw: Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])),
  }))
  const result = detection.adapter.normalize({
    formatId: detection.format.id, rows: sourceRows, rules,
    account: { id: accountId, marketplaceCode: "AMAZON", currency: "AED" },
  })
  const built = buildLedgerFilePayload({
    accountId, accountCurrency: "AED", format: detection.format,
    file: { name: `${SID}.txt`, type: "txt", sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") },
    columns: parsed.columns, rows: sourceRows, result,
  })
  check("the payload builder accepts it", built.ok, built.ok ? "" : built.problems.join(" | "))
  if (!built.ok) throw new Error("payload refused")

  const applied = await rpc("ledger_apply_file", { p_file: built.payload }, owner)
  const outcome = rows(applied)[0]
  check("A .TXT LEDGER FILE IS ACCEPTED BY THE DATABASE", applied.ok && outcome?.duplicate === false, say(applied))
  if (!applied.ok) throw new Error("apply failed")
  check(
    "14 rows, 13 lines, 1 settlement, 1 payout, 1 unmapped line",
    outcome.rows_written === 14 && outcome.transactions_written === 13 && outcome.settlements_written === 1 &&
      outcome.payouts_written === 1 && outcome.unmapped_written === 1,
    JSON.stringify(outcome)
  )
  const fileId: string = outcome.source_file_id

  /* ------------------------------------------------------------------------ */
  section("3. WHAT WAS WRITTEN")

  const summary = rows(await rpc("ledger_file_summary", { p_source_file_id: fileId }, owner))
  const bucket = (side: string | null, category: string, subcategory: string | null) =>
    summary.find((s) => s.side === side && s.category === category && s.subcategory === subcategory)

  check("principal sales: 300.0000", bucket("PNL", "REVENUE", "principal")?.total === "300.0000")
  check("shipping charged: 15.0000", bucket("PNL", "REVENUE", "shipping_charged")?.total === "15.0000")
  check(
    "referral fees net of the refund reversal: -24.0000 over 2 lines",
    bucket("PNL", "MARKETPLACE_FEE", "referral")?.total === "-24.0000" && Number(bucket("PNL", "MARKETPLACE_FEE", "referral")?.lines) === 2
  )
  check("the COD charge is other income: 10.0000", bucket("PNL", "OTHER_INCOME", "cod_charge")?.total === "10.0000")
  check("the SP 360 fee is a marketplace fee: -50.0000", bucket("PNL", "MARKETPLACE_FEE", "premium_services")?.total === "-50.0000")
  check("ITS VAT IS ON THE TAX SIDE: -2.5000", bucket("TAX", "FEE_VAT", "premium_services")?.total === "-2.5000")
  check("advertising: -40.0000", bucket("PNL", "ADVERTISING", "sponsored_ads")?.total === "-40.0000")
  check("the 0.00 storage fee is recorded as a zero line", bucket("PNL", "FULFILMENT", "storage")?.total === "0.0000")
  check("the unknown code is UNMAPPED with its amount kept", bucket(null, "UNMAPPED", null)?.total === "-5.0000")
  check("every total arrives as exact text", summary.every((s) => typeof s.total === "string"))

  const refundLine = rows(await read(`/rest/v1/ledger_lines?select=quantity,quantity_basis&source_file_id=eq.${fileId}&category=eq.REFUND`, owner))[0]
  check("a refund counts one derived unit", refundLine?.quantity === "1.0000" && refundLine?.quantity_basis === "DERIVED_LINE_COUNT")
  const principalLine = rows(await read(`/rest/v1/ledger_lines?select=quantity,quantity_basis,posted_at&source_file_id=eq.${fileId}&category=eq.REVENUE&subcategory=eq.principal`, owner))[0]
  check(
    "sold units are as reported, and the dotted date became a UTC instant",
    principalLine?.quantity === "3.0000" && principalLine?.quantity_basis === "REPORTED" && String(principalLine?.posted_at).startsWith("2026-07-04T11:00:00"),
    JSON.stringify(principalLine)
  )

  const settlements = rows(await rpc("ledger_file_settlements", { p_source_file_id: fileId }, owner))
  check(
    "THE SETTLEMENT RECONCILES: Amazon's total equals the sum of its lines",
    settlements.length === 1 && settlements[0].reported_total === "66.5000" && settlements[0].lines_total === "66.5000" && settlements[0].reconciles === true,
    JSON.stringify(settlements)
  )
  check("and its reported payout is the same total", settlements[0]?.payout_amount === "66.5000")

  const issues = rows(await read(`/rest/v1/import_issues?select=severity,message&batch_id=eq.${fileId}`, owner))
  check(
    "the unknown code is reported as a row issue naming it",
    issues.some((i) => i.severity === "WARNING" && String(i.message).includes("InventedFutureFee"))
  )

  /* ------------------------------------------------------------------------ */
  section("4. DATA SOURCES KNOWS IT IS A MARKETPLACE FILE")

  const overview = rows(await rpc("import_batch_overview", { p_limit: 50, p_offset: 0 }, owner)).find((r) => r.batch_id === fileId)
  check(
    "the overview labels it a ledger file of the Amazon.ae account",
    overview?.dataset === "LEDGER" && overview?.marketplace_label === "Amazon.ae" && overview?.marketplace_code === "AMAZON" &&
      overview?.format_id === "amazon.settlement.flat_file_v2",
    JSON.stringify(overview)
  )
  check(
    "with its counts: 13 lines, 1 settlement, 1 payout, 1 unmapped, and 13 records written",
    Number(overview?.transactions_count) === 13 && Number(overview?.settlements_count) === 1 &&
      Number(overview?.payouts_count) === 1 && Number(overview?.unmapped_count) === 1 && Number(overview?.records_written) === 13
  )

  const legacyPreview = await rpc("import_batch_withdrawal_preview", { p_batch_id: fileId }, owner)
  check(
    "the legacy withdrawal preview refuses a marketplace file",
    !legacyPreview.ok && JSON.stringify(legacyPreview.body).includes("marketplace file"),
    say(legacyPreview)
  )

  const again = await rpc("ledger_apply_file", { p_file: built.payload }, owner)
  check("uploading the same file again writes nothing", again.ok && rows(again)[0]?.duplicate === true)

  const withdrawn = await rpc("ledger_file_withdraw", { p_source_file_id: fileId, p_reason: "Verification" }, owner)
  const afterWithdraw = rows(await rpc("import_batch_overview", { p_limit: 50, p_offset: 0 }, owner)).find((r) => r.batch_id === fileId)
  check(
    "after withdrawal the overview says all 13 records are withdrawn",
    withdrawn.ok && Number(afterWithdraw?.records_withdrawn) === 13 && afterWithdraw?.withdrawn_at !== null,
    say(withdrawn)
  )
  check(
    "and the file's summary still shows its lines -- the evidence is kept",
    rows(await rpc("ledger_file_summary", { p_source_file_id: fileId }, owner)).length === summary.length
  )

  /* ------------------------------------------------------------------------ */
  section("5. ANOTHER BUSINESS SEES NOTHING")

  check(
    "the file summary returns nothing to an outsider",
    rows(await rpc("ledger_file_summary", { p_source_file_id: fileId }, rival)).length === 0
  )
  check(
    "nor do its settlements",
    rows(await rpc("ledger_file_settlements", { p_source_file_id: fileId }, rival)).length === 0
  )
  check(
    "nor does the overview",
    !rows(await rpc("import_batch_overview", { p_limit: 200, p_offset: 0 }, rival)).some((r) => r.batch_id === fileId)
  )
} catch (error) {
  failed += 1
  console.log(`\n  FAIL  the suite stopped early: ${(error as Error).message}`)
} finally {
  const removed = await request(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" }, owner)
  if (!removed.ok) console.log(`  note: the throwaway business could not be deleted: ${say(removed)}`)

  console.log(`\n${"=".repeat(74)}`)
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log("=".repeat(74))
}

process.exit(failed === 0 ? 0 : 1)
