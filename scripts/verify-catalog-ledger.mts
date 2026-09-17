/**
 * Product master, SKU matching, dated COGS and Gross Profit, end to end
 * against the real database (migration 0035).
 *
 * Run with:  npm run test:catalog-ledger
 *
 * INVENTED noon and Amazon exports (the real reports' shape, no real data) go
 * through the real upload path. Then:
 *   - unmatched SKUs keep gross profit incomplete and are queued, with
 *     suggestions that are never applied on their own
 *   - a match is confirmed or rejected by a person; a remap replaces the old one
 *   - the cost in force on each sale's date values it; a back-dated cost is the
 *     backfill that makes a month final; a withdrawn cost stops counting
 *   - a refund does not give COGS back (B17)
 *   - product rows add up to the account's contribution and gross profit
 *   - costs cannot be edited or deleted; another business sees nothing
 */

import { createHash } from "node:crypto"

import { requireConfig } from "./test-env.mjs"
import { parseFile } from "../src/services/ingestion/parse"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
import { AMAZON_V2_HEADERS } from "../src/services/marketplaces/amazon/flat-file-v2"
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

/* ---- invented exports ------------------------------------------------------ */

const RUN = Date.now().toString(36).toUpperCase()
const NOON_SKU = "sg-t84d/black"
const AMAZON_SKU = "SG-T84D-BLACK"
const MUG_SKU = `MUG-${RUN}`

const TV_MONEY = new Set([
  "Net Proceeds", "Referral Fee including VAT", "Fullfilment & Logistics Fees including VAT",
  "Shipping Credits including VAT", "Other Order Fees including VAT", "Order Subsidies including VAT",
  "Non-Order Fees including VAT", "Non-Order Subsidies including VAT", "Others including VAT", "Total",
])
const csvLine = (values: string[]) => values.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")
const ae = { Contract: `MP${RUN}AE`, "Contract Title": "NOON-AE", Currency: "AED" }
const item = (n: string, date: string, sku: string, extra: Record<string, string>) => ({
  ...ae, "Transaction Date": date, "Order Nr": `NAEI${RUN}${n}`, "Item Nr": `NAEI${RUN}${n}-1`, "Partner SKUs": sku,
  "Transaction Type": "order", Title: `Invented product ${sku}`, ...extra,
})
// Contribution: 90 + 90 + 45 - 3 - 20 = 202.00; three units sold.
const NOON_RECORDS: Record<string, string>[] = [
  item("1", "2026-07-04", NOON_SKU, { "Net Proceeds": "100", "Referral Fee including VAT": "-10", Total: "90" }),
  item("2", "2026-07-20", NOON_SKU, { "Net Proceeds": "100", "Referral Fee including VAT": "-10", Total: "90" }),
  item("3", "2026-07-05", MUG_SKU, { "Net Proceeds": "50", "Fullfilment & Logistics Fees including VAT": "-5", Total: "45" }),
  { ...ae, "Transaction Date": "2026-07-04", "Order Nr": `NAEI${RUN}1`, "Transaction Type": "order",
    "Fullfilment & Logistics Fees including VAT": "-3", Total: "-3" },
  { ...ae, "Transaction Date": "2026-07-08", "Order Nr": "NA", Title: "Advertising Fee", "Transaction Type": "statement_fee",
    "Reference Nr": `PS-${RUN}-AE20260708`, "Non-Order Fees including VAT": "-20", Total: "-20" },
]
const NOON_FILE = [
  csvLine([...NOON_TV_HEADERS]),
  ...NOON_RECORDS.map((r) => csvLine(NOON_TV_HEADERS.map((h) => r[h] ?? (TV_MONEY.has(h) ? "0" : "")))),
].join("\n") + "\n"

const SID = `8${Date.now().toString().slice(-10)}`
const tsv = (fields: Partial<Record<(typeof AMAZON_V2_HEADERS)[number], string>>) =>
  AMAZON_V2_HEADERS.map((header) => fields[header] ?? "").join("\t")
const amazonOrder = (description: string, amountType: string, amount: string) =>
  tsv({
    "settlement-id": SID, "transaction-type": "Order", "order-id": "999-2222222-2222222",
    "merchant-order-id": "999-2222222-2222222", "marketplace-name": "Amazon.ae", "amount-type": amountType,
    "amount-description": description, amount, "fulfillment-id": "AFN", "posted-date": "06.07.2026",
    "posted-date-time": "06.07.2026 10:00:00 UTC", "order-item-code": "44444444444444", sku: AMAZON_SKU,
    "quantity-purchased": "2",
  })
// Contribution: 200 - 20 - 50 - 10 = 120.00; two units sold, one refunded.
const AMAZON_FILE = [
  AMAZON_V2_HEADERS.join("\t"),
  tsv({ "settlement-id": SID, "settlement-start-date": "02.07.2026 00:00:00 UTC", "settlement-end-date": "16.07.2026 00:00:00 UTC",
    "deposit-date": "18.07.2026 00:00:00 UTC", "total-amount": "120.00", currency: "AED" }),
  amazonOrder("Principal", "ItemPrice", "200.00"),
  amazonOrder("Commission", "ItemFees", "-20.00"),
  tsv({ "settlement-id": SID, "transaction-type": "Refund", "order-id": "999-2222222-2222222", "amount-type": "ItemPrice",
    "amount-description": "Principal", amount: "-50.00", "posted-date": "09.07.2026", "posted-date-time": "09.07.2026 08:00:00 UTC",
    "adjustment-id": "55555555555", sku: AMAZON_SKU }),
  tsv({ "settlement-id": SID, "transaction-type": "ServiceFee", "amount-type": "Cost of Advertising",
    "amount-description": "TransactionTotalAmount", amount: "-10.00", "posted-date": "07.07.2026", "posted-date-time": "07.07.2026 00:00:00 UTC" }),
].join("\n") + "\n"

/* ---- setup ------------------------------------------------------------------ */

section("Setup -- a throwaway business with a noon and an Amazon AED account")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)

const created = await rpc("create_business", { p_name: `Catalog Verify ${suffix}`, p_slug: `catalog-verify-${suffix}`, p_currency: "AED" }, owner)
if (!created.ok) {
  console.log(`  could not create the business: ${say(created)}`)
  process.exit(1)
}
const businessId: string = created.body.id

async function upload(
  accountId: string,
  marketplaceCode: "NOON" | "AMAZON",
  name: string,
  type: "csv" | "txt",
  content: string
): Promise<Reply> {
  const buffer = Buffer.from(content, "utf8")
  const parsed = await parseFile(buffer, name)
  if ("error" in parsed) throw new Error(parsed.error)
  const detection = marketplaceAdapters.detect({ fileName: name, headers: parsed.columns, rows: [] })
  if (detection.kind !== "match") throw new Error(`${name}: not recognised (${detection.kind})`)
  const ruleRows = rows(await read(
    `/rest/v1/ledger_mapping_rules?select=id,match_key,side,category,subcategory,attribution,quantity_rule,sign_rule&marketplace_code=eq.${marketplaceCode}&format_id=eq.${detection.format.id}&status=eq.ACTIVE`,
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
    formatId: detection.format.id, rows: sourceRows, rules, account: { id: accountId, marketplaceCode, currency: "AED" },
  })
  const built = buildLedgerFilePayload({
    accountId, accountCurrency: "AED", format: detection.format,
    file: { name, type, sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") },
    columns: parsed.columns, rows: sourceRows, result,
  })
  if (!built.ok) throw new Error(`${name}: ${built.problems.join(" | ")}`)
  return rpc("ledger_apply_file", { p_file: built.payload }, owner)
}

try {
  const makeAccount = async (code: "NOON" | "AMAZON", label: string) => {
    const reply = await rpc("marketplace_account_create", {
      p_business_id: businessId, p_marketplace_code: code, p_label: label, p_country: "AE", p_currency: "AED",
    }, owner)
    if (!reply.ok) throw new Error(`Could not create ${label}: ${say(reply)}`)
    return reply.body as string
  }
  const noonAccount = await makeAccount("NOON", "noon UAE")
  const amazonAccount = await makeAccount("AMAZON", "Amazon.ae")
  // noon fees include VAT: as Non-recoverable they are already the right cost.
  await rpc("tax_profile_set_input_vat", { p_account_id: noonAccount, p_treatment: "NON_RECOVERABLE" }, owner)

  const JULY = { p_from: "2026-07-01T00:00:00Z", p_to: "2026-08-01T00:00:00Z" }
  const summary = async (account: string) => rows(await rpc("pnl_summary", { ...JULY, p_account_id: account }, owner))[0]
  const queue = async () => rows(await rpc("sku_mapping_queue", { p_business_id: businessId }, owner))
  const decide = (marketplace: string, sku: string, product: string, decision: string, token = owner) =>
    rpc("sku_alias_decide", {
      p_business_id: businessId, p_marketplace_code: marketplace, p_raw_sku: sku, p_product_id: product, p_decision: decision,
    }, token)
  const addCost = (product: string, cost: string, from: string, token = owner) =>
    rpc("product_cost_add", { p_product_id: product, p_currency: "AED", p_unit_cost: cost, p_effective_from: from }, token)

  const noonUpload = await upload(noonAccount, "NOON", `noon-tv-${RUN}.csv`, "csv", NOON_FILE)
  check("the invented noon export is recorded", noonUpload.ok, say(noonUpload))

  /* ------------------------------------------------------------------------ */
  section("1. NO PRODUCTS YET: CONTRIBUTION FINAL, GROSS PROFIT NOT")

  const first = await summary(noonAccount)
  check("contribution is FINAL at 202.0000", first?.contribution === "202.0000" && first?.contribution_status === "FINAL", JSON.stringify(first))
  check("3 units sold, none with a product", first?.units_sold === "3.0000" && first?.units_without_product === "3.0000")
  check(
    "gross profit is INCOMPLETE because SKUs are not matched",
    first?.gross_profit === null && first?.gross_profit_status === "INCOMPLETE" &&
      JSON.stringify(first?.gross_profit_reasons) === JSON.stringify(["SKU_NOT_MAPPED"]),
    JSON.stringify(first?.gross_profit_reasons)
  )
  check("COGS so far 0.0000; sales without a cost 250.0000", first?.cogs === "0.0000" && first?.sales_without_cost === "250.0000")
  check("informational gross profit 202.0000, never labelled final", first?.gross_profit_before_open_items === "202.0000")

  const q1 = await queue()
  const tumblerRow = q1.find((r) => r.raw_sku === NOON_SKU)
  check("both noon SKUs are queued, largest sales first", q1.length === 2 && q1[0].raw_sku === NOON_SKU, JSON.stringify(q1.map((r) => r.raw_sku)))
  check(
    "each queued SKU shows its lines, units, sales and a sample title",
    tumblerRow?.lines === 4 && tumblerRow?.units_sold === "2.0000" && tumblerRow?.net_sales === "200.0000" &&
      tumblerRow?.sample_title === `Invented product ${NOON_SKU}`,
    JSON.stringify(tumblerRow)
  )
  check("no suggestions while there are no products", q1.every((r) => r.suggestions.length === 0))

  /* ------------------------------------------------------------------------ */
  section("2. PRODUCTS AND SUGGESTIONS -- NOTHING IS MATCHED ON ITS OWN")

  const tumblerReply = await rpc("catalog_product_create", {
    p_business_id: businessId, p_name: "Invented tumbler", p_sku_code: AMAZON_SKU, p_category: "Drinkware",
  }, owner)
  const mugReply = await rpc("catalog_product_create", { p_business_id: businessId, p_name: "Invented mug" }, owner)
  check("the owner adds two products", tumblerReply.ok && mugReply.ok, `${say(tumblerReply)} ${say(mugReply)}`)
  const tumbler: string = tumblerReply.body
  const mug: string = mugReply.body

  const duplicate = await rpc("catalog_product_create", { p_business_id: businessId, p_name: "Copy", p_sku_code: "sg t84d black" }, owner)
  check(
    "a second product with the same SKU code (ignoring case and punctuation) is refused",
    !duplicate.ok && say(duplicate).includes("already uses that SKU code"), say(duplicate)
  )

  const q2 = await queue()
  const suggested = q2.find((r) => r.raw_sku === NOON_SKU)?.suggestions ?? []
  check(
    "the noon SKU is suggested for the tumbler (same SKU code)",
    suggested.length === 1 && suggested[0].product_id === tumbler && suggested[0].reason === "SAME_SKU_CODE",
    JSON.stringify(suggested)
  )
  check("but it is still unmatched", (await summary(noonAccount))?.units_without_product === "3.0000")

  const rejected = await decide("NOON", NOON_SKU, tumbler, "REJECTED")
  check("the owner rejects the suggestion", rejected.ok, say(rejected))
  check(
    "a rejected suggestion is not offered again",
    ((await queue()).find((r) => r.raw_sku === NOON_SKU)?.suggestions ?? []).length === 0
  )

  const notInFiles = await decide("NOON", "NEVER-SOLD", tumbler, "CONFIRMED")
  check("a SKU that is in no file cannot be matched", !notInFiles.ok && say(notInFiles).includes("does not appear"), say(notInFiles))
  const rivalDecide = await decide("NOON", NOON_SKU, tumbler, "CONFIRMED", rival)
  check("another business's user cannot match this business's SKUs", !rivalDecide.ok, say(rivalDecide))

  const confirmed = await decide("NOON", NOON_SKU, tumbler, "CONFIRMED")
  const mugConfirmed = await decide("NOON", MUG_SKU, mug, "CONFIRMED")
  check("the owner changes their mind and confirms both matches", confirmed.ok && mugConfirmed.ok, `${say(confirmed)} ${say(mugConfirmed)}`)

  const second = await summary(noonAccount)
  check(
    "every unit has a product; now the costs are missing",
    second?.units_without_product === "0.0000" && second?.units_without_cost === "3.0000" &&
      JSON.stringify(second?.gross_profit_reasons) === JSON.stringify(["COST_MISSING"]),
    JSON.stringify(second)
  )
  check("the queue is empty", (await queue()).length === 0)

  /* ------------------------------------------------------------------------ */
  section("3. DATED COSTS")

  for (const bad of ["12,5", "-1", "1.23456", "abc", ""]) {
    const reply = await addCost(tumbler, bad, "2026-07-01")
    check(`refused cost ${JSON.stringify(bad)}`, !reply.ok, say(reply))
  }
  const rivalCost = await addCost(tumbler, "1", "2026-07-01", rival)
  check("another business's user cannot add a cost", !rivalCost.ok, say(rivalCost))

  const c30 = await addCost(tumbler, "30", "2026-07-01")
  const c35 = await addCost(tumbler, "35.00", "2026-07-15")
  const mugAugust = await addCost(mug, "20", "2026-08-01")
  check("costs are added", c30.ok && c35.ok && mugAugust.ok, `${say(c30)} ${say(c35)} ${say(mugAugust)}`)

  const third = await summary(noonAccount)
  check(
    "each tumbler sale uses the cost in force on its date: -(30 + 35) = -65.0000",
    third?.cogs === "-65.0000", JSON.stringify(third)
  )
  check(
    "a cost starting in August does not value a July sale: still incomplete, 1 unit without a cost",
    third?.gross_profit === null && third?.units_without_cost === "1.0000" && third?.sales_without_cost === "50.0000",
    JSON.stringify(third)
  )

  const backfill = await addCost(mug, "20", "2026-06-01")
  check("a back-dated cost is the explicit backfill (B7)", backfill.ok, say(backfill))
  const fourth = await summary(noonAccount)
  check(
    "gross profit is FINAL: 202.00 - 85.00 = 117.0000",
    fourth?.gross_profit === "117.0000" && fourth?.gross_profit_status === "FINAL" && fourth?.cogs === "-85.0000" &&
      fourth?.gross_profit_reasons.length === 0,
    JSON.stringify(fourth)
  )

  const costRows = rows(await read(`/rest/v1/product_costs?select=id,unit_cost&product_id=eq.${tumbler}&effective_from=eq.2026-07-15`, owner))
  const cost35: string = costRows[0]?.id
  const edited = await request(`/rest/v1/product_costs?id=eq.${cost35}`, { method: "PATCH", body: JSON.stringify({ unit_cost: 1 }) }, owner)
  const deleted = await request(`/rest/v1/product_costs?id=eq.${cost35}`, { method: "DELETE" }, owner)
  const stillThere = rows(await read(`/rest/v1/product_costs?select=unit_cost&id=eq.${cost35}`, owner))[0]
  check(
    "a cost cannot be edited or deleted directly",
    (!edited.ok || rows(edited).length === 0) && (!deleted.ok || rows(deleted).length === 0) && stillThere?.unit_cost === 35,
    `${say(edited)} ${say(deleted)} ${JSON.stringify(stillThere)}`
  )

  const retired = await rpc("product_cost_retire", { p_cost_id: cost35, p_reason: "Entered by mistake" }, owner)
  check("the owner withdraws the 35.00 cost", retired.ok, say(retired))
  const again = await rpc("product_cost_retire", { p_cost_id: cost35 }, owner)
  check("it cannot be withdrawn twice", !again.ok, say(again))
  const fifth = await summary(noonAccount)
  check(
    "the later sale falls back to 30.00: COGS -80.0000, gross profit 122.0000",
    fifth?.cogs === "-80.0000" && fifth?.gross_profit === "122.0000", JSON.stringify(fifth)
  )

  /* ------------------------------------------------------------------------ */
  section("4. PRODUCT PROFIT ADDS UP")

  const byProduct = rows(await rpc("pnl_by_product", { ...JULY, p_account_id: noonAccount }, owner))
  const tumblerProfit = byProduct.find((r) => r.product_id === tumbler)
  const mugProfit = byProduct.find((r) => r.product_id === mug)
  const unallocated = byProduct.find((r) => r.row_kind === "NOT_ALLOCATED")
  check(
    "tumbler: 2 units, sales 200, costs -20, contribution 180, COGS -60, gross profit 120, margin 60.0%",
    tumblerProfit?.units_sold === "2.0000" && tumblerProfit?.net_sales === "200.0000" && tumblerProfit?.costs === "-20.0000" &&
      tumblerProfit?.contribution === "180.0000" && tumblerProfit?.cogs === "-60.0000" &&
      tumblerProfit?.gross_profit === "120.0000" && tumblerProfit?.gross_margin_percent === "60.0" &&
      tumblerProfit?.cogs_status === "COSTED",
    JSON.stringify(tumblerProfit)
  )
  check(
    "mug: contribution 45, gross profit 25, margin 50.0%",
    mugProfit?.contribution === "45.0000" && mugProfit?.gross_profit === "25.0000" && mugProfit?.gross_margin_percent === "50.0",
    JSON.stringify(mugProfit)
  )
  check(
    "the order-level fee and the advertising stay unallocated: -23.0000 (A7)",
    unallocated?.contribution === "-23.0000" && unallocated?.gross_profit === null && unallocated?.cogs_status === "NOT_APPLICABLE",
    JSON.stringify(unallocated)
  )
  check("three rows: 180 + 45 - 23 = 202 contribution; 120 + 25 - 23 = 122 gross profit", byProduct.length === 3)

  /* ------------------------------------------------------------------------ */
  section("5. THE SAME PRODUCT ON AMAZON; A REFUND KEEPS ITS COGS")

  const amazonUpload = await upload(amazonAccount, "AMAZON", `${SID}.txt`, "txt", AMAZON_FILE)
  check("the invented Amazon settlement is recorded", amazonUpload.ok, say(amazonUpload))

  const amazonQueue = (await queue()).find((r) => r.raw_sku === AMAZON_SKU && r.marketplace_code === "AMAZON")
  const reasons = (amazonQueue?.suggestions ?? []).map((s: Json) => `${s.reason}:${s.product_id === tumbler}`).sort()
  check(
    "the Amazon SKU is suggested for the tumbler twice over: same SKU code, and matched on noon",
    JSON.stringify(reasons) === JSON.stringify(["MAPPED_ON_OTHER_MARKETPLACE:true", "SAME_SKU_CODE:true"]),
    JSON.stringify(amazonQueue)
  )
  const amazonBefore = await summary(amazonAccount)
  check(
    "Amazon: contribution FINAL 120.0000, 2 units sold (the refund is not a sale), SKU not matched",
    amazonBefore?.contribution === "120.0000" && amazonBefore?.units_sold === "2.0000" &&
      JSON.stringify(amazonBefore?.gross_profit_reasons) === JSON.stringify(["SKU_NOT_MAPPED"]),
    JSON.stringify(amazonBefore)
  )

  await decide("AMAZON", AMAZON_SKU, tumbler, "CONFIRMED")
  const amazonAfter = await summary(amazonAccount)
  check(
    "matched: COGS -60.0000 for 2 units -- the refunded unit's cost is not given back (B17) -- gross profit 60.0000",
    amazonAfter?.cogs === "-60.0000" && amazonAfter?.gross_profit === "60.0000" && amazonAfter?.gross_profit_status === "FINAL",
    JSON.stringify(amazonAfter)
  )

  const combined = rows(await rpc("pnl_summary", { ...JULY, p_business_id: businessId, p_combine_by_currency: true }, owner))[0]
  check(
    "all AED accounts: contribution 322.0000, COGS -140.0000, gross profit 182.0000",
    combined?.accounts === 2 && combined?.contribution === "322.0000" && combined?.cogs === "-140.0000" &&
      combined?.gross_profit === "182.0000",
    JSON.stringify(combined)
  )
  const combinedProducts = rows(await rpc("pnl_by_product", { ...JULY, p_business_id: businessId }, owner))
  const tumblerAll = combinedProducts.find((r) => r.product_id === tumbler)
  check(
    "across both marketplaces the tumbler has 4 units and gross profit 190.0000 (noon 120 + Amazon 130 - 60)",
    tumblerAll?.units_sold === "4.0000" && tumblerAll?.gross_profit === "190.0000",
    JSON.stringify(tumblerAll)
  )

  /* ------------------------------------------------------------------------ */
  section("6. REMAPPING, REMOVING, ARCHIVING")

  await decide("NOON", MUG_SKU, tumbler, "CONFIRMED")
  const mugAliases = rows(await read(
    `/rest/v1/sku_aliases?select=product_id,status&business_id=eq.${businessId}&raw_sku=eq.${MUG_SKU}&order=status`,
    owner
  ))
  check(
    "matching a SKU to another product replaces the old match (kept as rejected)",
    mugAliases.length === 2 && mugAliases.some((a) => a.product_id === tumbler && a.status === "CONFIRMED") &&
      mugAliases.some((a) => a.product_id === mug && a.status === "REJECTED"),
    JSON.stringify(mugAliases)
  )
  const aliasId = rows(await read(
    `/rest/v1/sku_aliases?select=id&business_id=eq.${businessId}&raw_sku=eq.${MUG_SKU}&status=eq.CONFIRMED`,
    owner
  ))[0]?.id
  const removed = await rpc("sku_alias_remove", { p_alias_id: aliasId }, owner)
  const afterRemove = await summary(noonAccount)
  check(
    "removing the match makes gross profit incomplete again",
    removed.ok && afterRemove?.gross_profit === null && afterRemove?.gross_profit_reasons.includes("SKU_NOT_MAPPED"),
    `${say(removed)} ${JSON.stringify(afterRemove?.gross_profit_reasons)}`
  )

  const archived = await rpc("catalog_product_update", { p_product_id: mug, p_status: "ARCHIVED" }, owner)
  const toArchived = await decide("NOON", MUG_SKU, mug, "CONFIRMED")
  check("an archived product cannot receive a match", archived.ok && !toArchived.ok, say(toArchived))
  await rpc("catalog_product_update", { p_product_id: mug, p_status: "ACTIVE" }, owner)
  const rematched = await decide("NOON", MUG_SKU, mug, "CONFIRMED")
  const restored = await summary(noonAccount)
  check(
    "reactivated and matched again, gross profit is back to 122.0000",
    rematched.ok && restored?.gross_profit === "122.0000", `${say(rematched)} ${JSON.stringify(restored)}`
  )

  const audit = rows(await read(
    `/rest/v1/audit_logs?select=action&business_id=eq.${businessId}&action=in.(catalog_product.created,sku_alias.decided,sku_alias.removed,product_cost.added,product_cost.withdrawn,catalog_product.updated)`,
    owner
  ))
  const actions = new Set(audit.map((a) => a.action))
  check(
    "every change is in the audit log",
    ["catalog_product.created", "catalog_product.updated", "sku_alias.decided", "sku_alias.removed", "product_cost.added", "product_cost.withdrawn"]
      .every((a) => actions.has(a)),
    JSON.stringify([...actions])
  )

  /* ------------------------------------------------------------------------ */
  section("7. NOTHING CROSSES BUSINESSES")

  check("another business sees no products", rows(await read(`/rest/v1/catalog_products?select=id&business_id=eq.${businessId}`, rival)).length === 0)
  check("nor costs", rows(await read(`/rest/v1/product_costs?select=id&business_id=eq.${businessId}`, rival)).length === 0)
  check("nor matches", rows(await read(`/rest/v1/sku_aliases?select=id&business_id=eq.${businessId}`, rival)).length === 0)
  check("nor its queue", rows(await rpc("sku_mapping_queue", { p_business_id: businessId }, rival)).length === 0)
  check(
    "nor product profit, even naming this business",
    rows(await rpc("pnl_by_product", { ...JULY, p_business_id: businessId }, rival)).length === 0 &&
      rows(await rpc("catalog_product_overview", { p_business_id: businessId }, rival)).length === 0
  )
  const rivalCreate = await rpc("catalog_product_create", { p_business_id: businessId, p_name: "Intruder" }, rival)
  check("and cannot add a product to it", !rivalCreate.ok, say(rivalCreate))
  const insert = await request("/rest/v1/catalog_products", {
    method: "POST", body: JSON.stringify({ business_id: businessId, name: "Direct" }),
  }, owner)
  check("even the owner cannot write the tables directly", !insert.ok, say(insert))

  const overview = rows(await rpc("catalog_product_overview", { p_business_id: businessId }, owner))
  const tumblerOverview = overview.find((p) => p.product_id === tumbler)
  check(
    "the overview lists the tumbler with 2 matched SKUs and its cost today (30.0000)",
    tumblerOverview?.mapped_skus === 2 && tumblerOverview?.current_costs?.[0]?.unit_cost === "30.0000",
    JSON.stringify(tumblerOverview)
  )
} catch (error) {
  failed += 1
  console.log(`\n  FAIL  the suite stopped early: ${(error as Error).message}`)
} finally {
  const removed = await request(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" }, owner)
  check("the throwaway business is deleted, with its products and costs", removed.ok, removed.ok ? "" : say(removed))

  console.log(`\n${"=".repeat(74)}`)
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log("=".repeat(74))
}

process.exit(failed === 0 ? 0 : 1)
