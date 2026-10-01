/**
 * SKU setup, end to end against the real database (migration 0045).
 *
 * Run with:  npm run test:sku-setup-ledger
 *
 * An INVENTED fixture in a throwaway business, one Amazon.ae account:
 *   June    SG-T84D B Blue Fog FBA   2 units, 200.00
 *   July    SG-T84D B Blue Fog FBA   1 unit,  100.00
 *           VT-X521 Rose FBA         1 unit,   80.00
 *   August  sg t84d b blue fog fba   (identical, written differently)
 *           SG-T84D B Blue Fog       (similar but different)
 *           VT X521 ROSE FBA         (identical)
 *           XYZ-9                    (identical to a product's own SKU code)
 *           AMB-1 FBA, amb 1 fba     (an identical SKU that fits two products)
 *
 * Set up once (the sheet), remembered; identical SKUs matched automatically,
 * labelled and undoable; a first cost from the first sale; a changed cost from
 * today with history kept; conflicts refused; another business sees nothing.
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
const SID = (n: number) => `7${n}${RUN}`
const TODAY = new Date().toISOString().slice(0, 10)

const tsv = (fields: Partial<Record<(typeof AMAZON_V2_HEADERS)[number], string>>) =>
  AMAZON_V2_HEADERS.map((header) => fields[header] ?? "").join("\t")

/** One settlement: each line [sku, units, principal], posted on the 5th. */
function settlement(sid: string, month: "06" | "07" | "08", lines: [string, string, string][]): string {
  const total = lines.reduce((sum, [, , amount]) => sum + Number(amount), 0).toFixed(2)
  return [
    AMAZON_V2_HEADERS.join("\t"),
    tsv({ "settlement-id": sid, "settlement-start-date": `01.${month}.2026 00:00:00 UTC`,
      "settlement-end-date": `14.${month}.2026 00:00:00 UTC`, "deposit-date": `18.${month}.2026 00:00:00 UTC`,
      "total-amount": total, currency: "AED" }),
    ...lines.map(([sku, units, amount], i) => tsv({
      "settlement-id": sid, "transaction-type": "Order", "order-id": `997-${sid}-${i}`,
      "merchant-order-id": `997-${sid}-${i}`, "marketplace-name": "Amazon.ae", "amount-type": "ItemPrice",
      "amount-description": "Principal", amount, "fulfillment-id": "AFN", "posted-date": `05.${month}.2026`,
      "posted-date-time": `05.${month}.2026 10:00:00 UTC`, "order-item-code": `5${sid}${i}`, sku,
      "quantity-purchased": units,
    })),
  ].join("\n") + "\n"
}

const SG = "SG-T84D B Blue Fog FBA"
const VT = "VT-X521 Rose FBA"
const JUNE = settlement(SID(1), "06", [[SG, "2", "200.00"]])
const JULY = settlement(SID(2), "07", [[SG, "1", "100.00"], [VT, "1", "80.00"]])
const AUGUST = settlement(SID(3), "08", [
  ["sg t84d b blue fog fba", "1", "100.00"],
  ["SG-T84D B Blue Fog", "1", "100.00"],
  ["VT X521 ROSE FBA", "1", "80.00"],
  ["XYZ-9", "1", "10.00"],
  ["AMB-1 FBA", "1", "10.00"],
  ["amb 1 fba", "1", "10.00"],
])

/* ---- setup ------------------------------------------------------------------ */

section("Setup -- a throwaway business with one Amazon.ae account")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)

const created = await rpc("create_business", { p_name: `SKU Setup Verify ${suffix}`, p_slug: `sku-setup-verify-${suffix}`, p_currency: "AED" }, owner)
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

const alias = async (rawSku: string) =>
  rows(await read(
    `/rest/v1/sku_aliases?select=id,product_id,status,method&business_id=eq.${businessId}&raw_sku=eq.${encodeURIComponent(rawSku)}&status=eq.CONFIRMED`,
    owner
  ))[0] ?? null
const costsOf = async (productId: string) =>
  rows(await read(
    `/rest/v1/product_costs?select=unit_cost,effective_from,source,retired_at&product_id=eq.${productId}&order=effective_from`,
    owner
  ))
const productBySku = async (skuCode: string) =>
  rows(await read(
    `/rest/v1/catalog_products?select=id,name,sku_code&business_id=eq.${businessId}&sku_code=eq.${encodeURIComponent(skuCode)}`,
    owner
  ))[0] ?? null
const junePnl = async () =>
  rows(await rpc("pnl_by_product", {
    p_from: "2026-06-01T00:00:00Z", p_to: "2026-07-01T00:00:00Z", p_business_id: businessId,
  }, owner)).find((r) => r.row_kind === "PRODUCT")

try {
  const accountReply = await rpc("marketplace_account_create", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_label: "Amazon.ae", p_country: "AE", p_currency: "AED",
  }, owner)
  if (!accountReply.ok) throw new Error(`Could not create the account: ${say(accountReply)}`)
  const account = accountReply.body as string

  const first = [await upload(account, `${SID(1)}.txt`, JUNE), await upload(account, `${SID(2)}.txt`, JULY)]
  check("June and July are recorded", first.every((r) => r.ok), first.filter((r) => !r.ok).map(say).join(" | "))

  /* ------------------------------------------------------------------------ */
  section("1. FIRST SETUP: ONE SHEET, TWO SKUS")

  const template = rows(await rpc("sku_setup_rows", { p_business_id: businessId }, owner))
  const sgRow = template.find((r) => r.raw_sku === SG)
  check("the sheet lists the two SKUs that need a product, largest sales first",
    template.length === 2 && template[0].raw_sku === SG && template[1].raw_sku === VT, JSON.stringify(template.map((r) => r.raw_sku)))
  check("with their units, net sales, currency and first sale",
    sgRow?.units_sold === "3.0000" && sgRow?.net_sales === "300.0000" && sgRow?.currency === "AED" &&
      sgRow?.first_sold === "2026-06-05" && sgRow?.product_id === null, JSON.stringify(sgRow))

  const sheet = [
    { row: 2, marketplace_code: "AMAZON", raw_sku: SG, product_sku: "SG-T84D", product_name: "Blue Fog 24in", unit_cost: "120", currency: "AED" },
    { row: 3, marketplace_code: "AMAZON", raw_sku: VT, product_sku: "VT-X521", product_name: null, unit_cost: "80.00", currency: "AED" },
  ]
  const applied = await rpc("sku_setup_apply", { p_business_id: businessId, p_rows: sheet }, owner)
  check("the sheet creates two products, matches two SKUs and adds two costs",
    applied.ok && applied.body.products_created === 2 && applied.body.skus_matched === 2 && applied.body.costs_added === 2,
    say(applied))
  check("both first costs start from each product's first sale", applied.body?.costs_backfilled === 2)

  const sgProduct = await productBySku("SG-T84D")
  const sgCosts = sgProduct ? await costsOf(sgProduct.id) : []
  check("SG-T84D costs 120 from 5 June 2026, from the sheet",
    sgCosts.length === 1 && sgCosts[0].unit_cost === 120 && sgCosts[0].effective_from === "2026-06-05" && sgCosts[0].source === "EXCEL",
    JSON.stringify(sgCosts))
  check("a new product is named from the sheet, or after its SKU", sgProduct?.name === "Blue Fog 24in" &&
    (await productBySku("VT-X521"))?.name === "VT-X521")
  check("the mapping is remembered, labelled as from the sheet", (await alias(SG))?.method === "EXCEL")

  const june = await junePnl()
  check("June's gross profit now has its cost: 2 units x 120",
    june?.product_id === sgProduct?.id && ["240.0000", "-240.0000"].includes(june?.cogs) && june?.cogs_status === "COSTED",
    JSON.stringify(june))
  check("nothing is left to set up", rows(await rpc("sku_setup_rows", { p_business_id: businessId }, owner)).length === 0)

  /* ------------------------------------------------------------------------ */
  section("2. APPLYING AGAIN, CHANGING A COST, CONFLICTS")

  const again = await rpc("sku_setup_apply", { p_business_id: businessId, p_rows: sheet }, owner)
  check("the same sheet again changes nothing",
    again.ok && again.body.skus_unchanged === 2 && again.body.costs_unchanged === 2 && again.body.costs_added === 0 &&
      again.body.products_created === 0, say(again))

  const changed = await rpc("sku_setup_apply", {
    p_business_id: businessId, p_rows: [{ ...sheet[0], unit_cost: "135" }],
  }, owner)
  const history = sgProduct ? await costsOf(sgProduct.id) : []
  check("a different cost for a product with a cost starts today",
    changed.ok && changed.body.costs_added === 1 && changed.body.costs_backfilled === 0 &&
      history.some((c) => c.unit_cost === 135 && c.effective_from === TODAY), JSON.stringify(history))
  check("the earlier cost is kept, untouched", history.some((c) => c.unit_cost === 120 && c.effective_from === "2026-06-05" && c.retired_at === null))
  const juneAfter = await junePnl()
  check("June still uses 120 (history is never rewritten)", juneAfter?.cogs === june?.cogs, JSON.stringify(juneAfter))

  const twoCosts = await rpc("sku_setup_apply", {
    p_business_id: businessId,
    p_rows: [{ ...sheet[0], unit_cost: "140" }, { ...sheet[1], row: 7, product_sku: "sg t84d", unit_cost: "150" }],
  }, owner)
  check("one Product SKU with two costs in a sheet is refused", !twoCosts.ok && String(twoCosts.body?.message).includes("different costs"), say(twoCosts))
  const twoProducts = await rpc("sku_setup_apply", {
    p_business_id: businessId,
    p_rows: [sheet[0], { ...sheet[0], row: 9, product_sku: "VT-X521", unit_cost: null, currency: null }],
  }, owner)
  check("one SKU given two products is refused", !twoProducts.ok && String(twoProducts.body?.message).includes("one product"), say(twoProducts))
  const unknown = await rpc("sku_setup_apply", {
    p_business_id: businessId, p_rows: [{ ...sheet[0], raw_sku: "NOT-IN-ANY-FILE" }],
  }, owner)
  check("a SKU that is in no file is refused", !unknown.ok && String(unknown.body?.message).includes("does not appear"), say(unknown))

  /* ------------------------------------------------------------------------ */
  section("3. NEXT MONTH: KNOWN SKUS RECOGNISED, IDENTICAL SKUS MATCHED")

  const xyz = await rpc("catalog_product_create", { p_business_id: businessId, p_name: "XYZ nine", p_sku_code: "XYZ 9" }, owner)
  const amb = await rpc("catalog_product_create", { p_business_id: businessId, p_name: "AMB one", p_sku_code: "AMB 1 FBA" }, owner)
  const other = await rpc("catalog_product_create", { p_business_id: businessId, p_name: "Another", p_sku_code: "OTHER-1" }, owner)
  const aug = await upload(account, `${SID(3)}.txt`, AUGUST)
  check("August is recorded", aug.ok && xyz.ok && amb.ok && other.ok, say(aug))
  const augFile: string = rows(aug)[0]?.source_file_id
  // "AMB-1 FBA" belongs to a different product than the one whose code is "AMB 1 FBA".
  const ambManual = await rpc("sku_alias_decide", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_raw_sku: "AMB-1 FBA", p_product_id: other.body, p_decision: "CONFIRMED",
  }, owner)
  check("a person matches AMB-1 FBA to another product", ambManual.ok, say(ambManual))

  const matched = await rpc("sku_auto_match", { p_business_id: businessId }, owner)
  check("three identical SKUs are matched automatically", matched.ok && matched.body === 3, say(matched))
  const variant = await alias("sg t84d b blue fog fba")
  check("'sg t84d b blue fog fba' is SG-T84D, labelled automatic", variant?.product_id === sgProduct?.id && variant?.method === "AUTOMATIC")
  check("'VT X521 ROSE FBA' is VT-X521", (await alias("VT X521 ROSE FBA"))?.method === "AUTOMATIC")
  check("'XYZ-9' matches the product whose own code is 'XYZ 9'", (await alias("XYZ-9"))?.product_id === xyz.body)
  check("'SG-T84D B Blue Fog' (similar, not identical) is NOT matched", (await alias("SG-T84D B Blue Fog")) === null)
  check("'amb 1 fba' fits two products, so it is NOT matched", (await alias("amb 1 fba")) === null)
  check("and the costs follow the product automatically: August's SG line is costed at 135",
    rows(await rpc("pnl_by_product", { p_from: "2026-08-01T00:00:00Z", p_to: "2026-09-01T00:00:00Z", p_business_id: businessId }, owner))
      .some((r) => r.product_id === sgProduct?.id && r.cogs_status === "COSTED"))

  const summary = rows(await rpc("ledger_file_sku_summary", { p_source_file_id: augFile }, owner))[0]
  check("the August file: 6 SKUs, 4 recognised (3 automatically), 2 need mapping",
    summary?.skus === 6 && summary?.recognised === 4 && summary?.matched_automatically === 3 && summary?.need_attention === 2,
    JSON.stringify(summary))
  const queue = rows(await rpc("sku_mapping_queue", { p_business_id: businessId }, owner)).map((r) => r.raw_sku).sort()
  check("only the two genuinely new SKUs need attention", JSON.stringify(queue) === JSON.stringify(["SG-T84D B Blue Fog", "amb 1 fba"]),
    JSON.stringify(queue))

  /* ------------------------------------------------------------------------ */
  section("4. UNDO, REJECTIONS AND CONFIRMED MAPPINGS")

  const undo = await rpc("sku_alias_decide", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_raw_sku: "sg t84d b blue fog fba", p_product_id: sgProduct?.id, p_decision: "REJECTED",
  }, owner)
  const rerun = await rpc("sku_auto_match", { p_business_id: businessId }, owner)
  check("an undone automatic match stays undone", undo.ok && rerun.body === 0 && (await alias("sg t84d b blue fog fba")) === null, say(rerun))

  const person = await rpc("sku_alias_decide", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_raw_sku: "SG-T84D B Blue Fog", p_product_id: xyz.body, p_decision: "CONFIRMED",
  }, owner)
  await rpc("catalog_product_create", { p_business_id: businessId, p_name: "Would collide", p_sku_code: "SG-T84D-B-BLUE-FOG" }, owner)
  await rpc("sku_auto_match", { p_business_id: businessId }, owner)
  const kept = await alias("SG-T84D B Blue Fog")
  check("a confirmed mapping is never replaced by an automatic one",
    person.ok && kept?.product_id === xyz.body && kept?.method === "MANUAL", JSON.stringify(kept))

  /* ------------------------------------------------------------------------ */
  section("5. ISOLATION")

  const rivalAuto = await rpc("sku_auto_match", { p_business_id: businessId }, rival)
  check("another business cannot run matching on this one", !rivalAuto.ok, say(rivalAuto))
  const rivalApply = await rpc("sku_setup_apply", { p_business_id: businessId, p_rows: sheet }, rival)
  check("nor apply a sheet to it", !rivalApply.ok, say(rivalApply))
  check("nor read its SKUs", rows(await rpc("sku_setup_rows", { p_business_id: businessId, p_include_matched: true }, rival)).length === 0)
  const rivalSummary = rows(await rpc("ledger_file_sku_summary", { p_source_file_id: augFile }, rival))[0]
  check("nor count a file's SKUs", !rivalSummary || rivalSummary.skus === 0, JSON.stringify(rivalSummary))
  const anon = await request("/rest/v1/rpc/sku_auto_match", { method: "POST", body: JSON.stringify({ p_business_id: businessId }) }, ANON_KEY)
  check("a signed-out caller cannot run it", !anon.ok, say(anon))

  /* ------------------------------------------------------------------------ */
  section("6. A SKU MATCHED LATER, WITH EARLIER SALES AT THE SAME COST (0054)")

  // The real bug (owner's live data, 2026-09-26): a product already has a
  // cost; a SEPARATE, later sheet matches one more marketplace SKU to that
  // SAME product, at the SAME cost -- but that SKU's own sales reach back
  // before the cost's effective_from. The old code's "cost unchanged, do
  // nothing" shortcut left those sales permanently uncosted, with no page
  // ever pointing at the gap. sgProduct already has 120 AED from 2026-06-05
  // and 135 AED from today (section 2); May, before either, is the gap.
  const MAY_SKU = "SG-MAY-EARLY FBA"
  const MAY = [
    AMAZON_V2_HEADERS.join("\t"),
    tsv({ "settlement-id": SID(4), "settlement-start-date": "01.05.2026 00:00:00 UTC",
      "settlement-end-date": "14.05.2026 00:00:00 UTC", "deposit-date": "18.05.2026 00:00:00 UTC",
      "total-amount": "90.00", currency: "AED" }),
    tsv({ "settlement-id": SID(4), "transaction-type": "Order", "order-id": `997-${SID(4)}-0`,
      "merchant-order-id": `997-${SID(4)}-0`, "marketplace-name": "Amazon.ae", "amount-type": "ItemPrice",
      "amount-description": "Principal", amount: "90.00", "fulfillment-id": "AFN", "posted-date": "20.05.2026",
      "posted-date-time": "20.05.2026 10:00:00 UTC", "order-item-code": `5${SID(4)}0`, sku: MAY_SKU,
      "quantity-purchased": "1" }),
  ].join("\n") + "\n"

  const mayUpload = await upload(account, `${SID(4)}.txt`, MAY)
  check("May, with the new SKU, is recorded", mayUpload.ok, say(mayUpload))

  const gapApply = await rpc("sku_setup_apply", {
    p_business_id: businessId,
    p_rows: [{ row: 2, marketplace_code: "AMAZON", raw_sku: MAY_SKU, product_id: sgProduct?.id, unit_cost: "135", currency: "AED" }],
  }, owner)
  check("matching it at the SAME cost (135) already on file backfills one more cost row",
    gapApply.ok && gapApply.body.skus_matched === 1 && gapApply.body.costs_added === 1 &&
      gapApply.body.costs_backfilled === 1 && gapApply.body.costs_unchanged === 0,
    say(gapApply))

  const historyAfterGapFix = sgProduct ? await costsOf(sgProduct.id) : []
  check("the new row covers exactly the gap: 135 AED from 20 May 2026, alongside the two already there",
    historyAfterGapFix.some((c) => c.unit_cost === 135 && c.effective_from === "2026-05-20") &&
      historyAfterGapFix.some((c) => c.unit_cost === 120 && c.effective_from === "2026-06-05") &&
      historyAfterGapFix.some((c) => c.unit_cost === 135 && c.effective_from === TODAY),
    JSON.stringify(historyAfterGapFix))

  const mayAfterFix = rows(await rpc("pnl_by_product", {
    p_from: "2026-05-01T00:00:00Z", p_to: "2026-06-01T00:00:00Z", p_business_id: businessId,
  }, owner)).find((r) => r.product_id === sgProduct?.id)
  check("May is COSTED now, at 1 x 135", mayAfterFix?.cogs_status === "COSTED" &&
    ["135.0000", "-135.0000"].includes(mayAfterFix?.cogs), JSON.stringify(mayAfterFix))

  const reapply = await rpc("sku_setup_apply", {
    p_business_id: businessId,
    p_rows: [{ row: 2, marketplace_code: "AMAZON", raw_sku: MAY_SKU, product_id: sgProduct?.id, unit_cost: "135", currency: "AED" }],
  }, owner)
  check("applying the same row again finds no further gap: nothing added",
    reapply.ok && reapply.body.costs_added === 0 && reapply.body.costs_unchanged === 1, say(reapply))
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
