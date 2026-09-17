/**
 * The P&L engine and automatic classification, against the real database
 * (migration 0032).
 *
 * Run with:  npm run test:pnl
 *
 * An INVENTED Amazon settlement (the real report's shape, no real data) with
 * one code BizMind has never seen goes through the real upload path. Then:
 *
 *   - every known line is classified automatically; the new code is Unknown
 *   - figures are exact, per the model, and Incomplete while anything is open
 *   - the account's VAT setting decides the VAT line's effect (B1)
 *   - classifying the unknown code makes the figures Final WITHOUT a re-upload
 *   - a correction is a new version; retiring it makes the code Unknown again
 *   - another business sees none of it, and nobody can edit a rule directly
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

/* ---- an invented settlement ---------------------------------------------- */

const FORMAT = "amazon.settlement.flat_file_v2"
const UNKNOWN_KEY = "Order|ItemFees|InventedFutureFee"
const SID = `8${Date.now().toString().slice(-10)}`

function tsv(fields: Partial<Record<(typeof AMAZON_V2_HEADERS)[number], string>>): string {
  return AMAZON_V2_HEADERS.map((header) => fields[header] ?? "").join("\t")
}

const orderLine = (description: string, amountType: string, amount: string) =>
  tsv({
    "settlement-id": SID, "transaction-type": "Order", "order-id": "999-2222222-2222222",
    "merchant-order-id": "999-2222222-2222222", "marketplace-name": "Amazon.ae", "amount-type": amountType,
    "amount-description": description, amount, "fulfillment-id": "AFN", "posted-date": "04.07.2026",
    "posted-date-time": "04.07.2026 11:00:00 UTC", "order-item-code": "33333333333333", sku: "INVENTED-SKU",
    "quantity-purchased": "3",
  })

// 300 + 15 - 36 - 27 + 10 - 10 - 100 + 12 - 40 - 50 - 2.50 + 0 - 5 = 66.50
const content = [
  AMAZON_V2_HEADERS.join("\t"),
  tsv({ "settlement-id": SID, "settlement-start-date": "02.07.2026 18:27:57 UTC", "settlement-end-date": "16.07.2026 18:27:57 UTC", "deposit-date": "18.07.2026 18:27:57 UTC", "total-amount": "66.50", currency: "AED" }),
  orderLine("Principal", "ItemPrice", "300.00"),
  orderLine("Shipping", "ItemPrice", "15.00"),
  orderLine("Commission", "ItemFees", "-36.00"),
  orderLine("FBAPerUnitFulfillmentFee", "ItemFees", "-27.00"),
  orderLine("COD", "ItemPrice", "10.00"),
  orderLine("CODFee", "ItemFees", "-10.00"),
  tsv({ "settlement-id": SID, "transaction-type": "Refund", "order-id": "999-2222222-2222222", "amount-type": "ItemPrice", "amount-description": "Principal", amount: "-100.00", "posted-date": "06.07.2026", "posted-date-time": "06.07.2026 08:00:00 UTC", "adjustment-id": "44444444444", sku: "INVENTED-SKU" }),
  tsv({ "settlement-id": SID, "transaction-type": "Refund", "order-id": "999-2222222-2222222", "amount-type": "ItemFees", "amount-description": "Commission", amount: "12.00", "posted-date": "06.07.2026", "posted-date-time": "06.07.2026 08:00:00 UTC", sku: "INVENTED-SKU" }),
  tsv({ "settlement-id": SID, "transaction-type": "ServiceFee", "amount-type": "Cost of Advertising", "amount-description": "TransactionTotalAmount", amount: "-40.00", "posted-date": "07.07.2026", "posted-date-time": "07.07.2026 00:00:00 UTC" }),
  tsv({ "settlement-id": SID, "transaction-type": "AmazonFees", "marketplace-name": "Amazon.ae", "amount-type": "Premium Services Fee", "amount-description": "Base fee", amount: "-50.00", "posted-date": "02.07.2026", "posted-date-time": "02.07.2026 12:00:00 UTC" }),
  tsv({ "settlement-id": SID, "transaction-type": "AmazonFees", "marketplace-name": "Amazon.ae", "amount-type": "Premium Services Fee", "amount-description": "Tax on fee", amount: "-2.50", "posted-date": "02.07.2026", "posted-date-time": "02.07.2026 12:00:00 UTC" }),
  tsv({ "settlement-id": SID, "transaction-type": "FBAFees", "marketplace-name": "Amazon.ae", "amount-type": "FBA Inventory Storage Fee", "amount-description": "Base fee", amount: "0.00", "fulfillment-id": "AFN", "posted-date": "07.07.2026", "posted-date-time": "07.07.2026 00:00:00 UTC" }),
  orderLine("InventedFutureFee", "ItemFees", "-5.00"),
].join("\n") + "\n"

/* ---- setup --------------------------------------------------------------- */

section("Setup -- a throwaway business, an Amazon.ae account, one uploaded file")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)

const created = await rpc("create_business", { p_name: `PnL Verify ${suffix}`, p_slug: `pnl-verify-${suffix}`, p_currency: "AED" }, owner)
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

  const ruleRows = rows(await read(
    `/rest/v1/ledger_mapping_rules?select=id,match_key,side,category,subcategory,attribution,quantity_rule,sign_rule&marketplace_code=eq.AMAZON&format_id=eq.${FORMAT}&status=eq.ACTIVE`,
    owner
  ))
  const rules: MappingRuleSummary[] = ruleRows.map((rule) => ({
    id: rule.id, matchKey: rule.match_key, side: rule.side, category: rule.category, subcategory: rule.subcategory,
    attribution: rule.attribution, quantityRule: rule.quantity_rule, signRule: rule.sign_rule,
  }))

  const buffer = Buffer.from(content, "utf8")
  const parsed = await parseFile(buffer, `${SID}.txt`)
  if ("error" in parsed) throw new Error(parsed.error)
  const detection = marketplaceAdapters.detect({ fileName: `${SID}.txt`, headers: parsed.columns, rows: [] })
  if (detection.kind !== "match") throw new Error("not recognised")
  const sourceRows: SourceRow[] = parsed.rows.map((record, index) => ({
    rowNumber: index + 2,
    raw: Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])),
  }))
  const result = detection.adapter.normalize({
    formatId: detection.format.id, rows: sourceRows, rules, account: { id: accountId, marketplaceCode: "AMAZON", currency: "AED" },
  })
  const built = buildLedgerFilePayload({
    accountId, accountCurrency: "AED", format: detection.format,
    file: { name: `${SID}.txt`, type: "txt", sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") },
    columns: parsed.columns, rows: sourceRows, result,
  })
  if (!built.ok) throw new Error(built.problems.join(" | "))
  const applied = await rpc("ledger_apply_file", { p_file: built.payload }, owner)
  if (!applied.ok) throw new Error(`apply failed: ${say(applied)}`)
  const fileId: string = rows(applied)[0].source_file_id
  check("the invented file is recorded (13 lines)", rows(applied)[0].transactions_written === 13, say(applied))

  const JULY = { p_from: "2026-07-01T00:00:00Z", p_to: "2026-08-01T00:00:00Z", p_account_id: accountId }
  const summaryAs = async (token: string) => rows(await rpc("pnl_summary", JULY, token))[0]
  const quality = async () => rows(await rpc("ledger_data_quality", { p_account_id: accountId }, owner))
  const setVat = (treatment: string, token = owner) =>
    rpc("tax_profile_set_input_vat", { p_account_id: accountId, p_treatment: treatment }, token)

  /* ------------------------------------------------------------------------ */
  section("1. EVERY KNOWN LINE IS CLASSIFIED AUTOMATICALLY")

  const lines = rows(await read(
    `/rest/v1/ledger_classified_lines?select=match_key,financial_type,category,subcategory,pnl_treatment,classification_status,amount&source_file_id=eq.${fileId}`,
    owner
  ))
  const line = (key: string) => lines.find((l) => l.match_key === key)
  check("13 classified lines are visible to the owner", lines.length === 13, String(lines.length))
  check(
    "12 known lines CLASSIFIED with no question asked; the new code is UNKNOWN",
    lines.filter((l) => l.classification_status === "CLASSIFIED").length === 12 &&
      line(UNKNOWN_KEY)?.classification_status === "UNKNOWN" && line(UNKNOWN_KEY)?.category === null
  )
  const principal = line("Order|ItemPrice|Principal")
  check(
    "Principal -> Revenue / Product Sales / Increase Revenue",
    principal?.financial_type === "REVENUE" && principal?.category === "PRODUCT_SALES" && principal?.pnl_treatment === "INCREASE_REVENUE",
    JSON.stringify(principal)
  )
  const refund = line("Refund|ItemPrice|Principal")
  check(
    "Refund Principal -> Revenue / Sales Refunds / Decrease Revenue (not an expense)",
    refund?.financial_type === "REVENUE" && refund?.category === "SALES_REFUNDS" && refund?.pnl_treatment === "DECREASE_REVENUE"
  )
  const reversal = line("Refund|ItemFees|Commission")
  check(
    "a commission reversal keeps Marketplace Fee; its positive sign shows the reversal",
    reversal?.category === "MARKETPLACE_FEE" && reversal?.pnl_treatment === "INCREASE_EXPENSE" && reversal?.amount === "12.0000"
  )
  const vat = line("AmazonFees|Premium Services Fee|Tax on fee")
  check(
    "Tax on fee -> Tax / Input VAT / Conditional while the VAT setting is Unknown",
    vat?.financial_type === "TAX" && vat?.category === "INPUT_VAT" && vat?.pnl_treatment === "CONDITIONAL"
  )

  /* ------------------------------------------------------------------------ */
  section("2. FIGURES ARE EXACT AND INCOMPLETE WHILE ANYTHING IS OPEN")

  const first = await summaryAs(owner)
  check("gross sales 315.0000", first?.gross_sales === "315.0000", JSON.stringify(first))
  check("sales refunds -100.0000, seller discounts 0.0000", first?.sales_refunds === "-100.0000" && first?.seller_discounts === "0.0000")
  check("net sales 215.0000", first?.net_sales === "215.0000")
  check("other income 10.0000 (the COD charge)", first?.other_income === "10.0000")
  check(
    "marketplace fees -84.0000 (commission -36, reversal +12, COD fee -10, SP 360 -50)",
    first?.marketplace_fees === "-84.0000"
  )
  check("fulfillment -27.0000 (storage 0.00 included)", first?.fulfillment === "-27.0000")
  check("advertising -40.0000", first?.advertising === "-40.0000")
  check(
    "NO final contribution while a code is unknown and VAT is unresolved",
    first?.contribution === null && first?.contribution_status === "INCOMPLETE" && first?.figures_status === "INCOMPLETE"
  )
  check(
    "the reasons are named: unknown lines and VAT treatment",
    JSON.stringify(first?.incomplete_reasons) === JSON.stringify(["UNKNOWN_LINES", "VAT_TREATMENT_UNKNOWN"]),
    JSON.stringify(first?.incomplete_reasons)
  )
  check(
    "the open amounts are exact: 1 unknown line of -5.0000, VAT -2.5000 unresolved",
    first?.unknown_lines === 1 && first?.unknown_amount === "-5.0000" && first?.input_vat_unresolved === "-2.5000"
  )
  check("informational contribution before open items: 74.0000", first?.contribution_before_open_items === "74.0000")

  const breakdown = rows(await rpc("pnl_breakdown", JULY, owner))
  check(
    "the breakdown lists the unknown code by its key, with its amount",
    breakdown.some((b) => b.classification_status === "UNKNOWN" && b.match_key === UNKNOWN_KEY && b.total === "-5.0000")
  )

  const issues = await quality()
  check(
    "Data Quality: the unknown code, with its lines and amount",
    issues.some((i) => i.issue_kind === "UNKNOWN_CODE" && i.reference === UNKNOWN_KEY && i.lines === 1 && i.amount === "-5.0000"),
    JSON.stringify(issues)
  )
  check(
    "Data Quality: the VAT setting is Unknown",
    issues.some((i) => i.issue_kind === "VAT_TREATMENT_UNKNOWN" && i.amount === "-2.5000")
  )
  check("Data Quality: the settlement reconciles, so no mismatch", !issues.some((i) => i.issue_kind === "SETTLEMENT_MISMATCH"))

  /* ------------------------------------------------------------------------ */
  section("3. THE VAT SETTING DECIDES THE VAT LINE (B1)")

  const recoverable = await setVat("RECOVERABLE")
  check("the owner sets Recoverable", recoverable.ok, say(recoverable))
  const second = await summaryAs(owner)
  check(
    "Recoverable: the VAT has no P&L impact, but the unknown code still keeps contribution incomplete",
    second?.input_vat_recoverable === "-2.5000" && second?.input_vat_unresolved === "0.0000" &&
      second?.contribution === null && JSON.stringify(second?.incomplete_reasons) === JSON.stringify(["UNKNOWN_LINES"])
  )

  const refusedVat = await setVat("RECOVERABLE", rival)
  check("another business cannot change this account's VAT setting", !refusedVat.ok && say(refusedVat).includes("could not be found"), say(refusedVat))
  const badVat = await setVat("ZERO")
  check("an invalid setting is refused", !badVat.ok && say(badVat).includes("Recoverable, Non-recoverable or Unknown"))

  /* ------------------------------------------------------------------------ */
  section("4. CLASSIFYING THE UNKNOWN CODE -- NO RE-UPLOAD")

  const impact = rows(await rpc(
    "classification_rule_impact",
    { p_business_id: businessId, p_marketplace_code: "AMAZON", p_format_id: FORMAT, p_match_key: UNKNOWN_KEY },
    owner
  ))
  check(
    "the impact preview shows exactly what would move: 1 line, -5.0000, July, currently Unknown",
    impact.length === 1 && impact[0].lines === 1 && impact[0].amount === "-5.0000" &&
      impact[0].month === "2026-07-01" && impact[0].classification_status === "UNKNOWN",
    JSON.stringify(impact)
  )

  const known = await rpc("classification_rule_classify", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_format_id: FORMAT,
    p_match_key: "Order|ItemFees|Commission", p_category: "PENALTY", p_subcategory: "Not a penalty",
  }, owner)
  check("a code BizMind classifies cannot be overridden by a business", !known.ok && say(known).includes("BizMind already classifies"), say(known))

  const absent = await rpc("classification_rule_classify", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_format_id: FORMAT,
    p_match_key: "Order|ItemFees|NeverSeenAnywhere", p_category: "PENALTY", p_subcategory: "Nothing",
  }, owner)
  check("a code that is not in the business's files cannot be classified", !absent.ok && say(absent).includes("does not appear"), say(absent))

  const outsider = await rpc("classification_rule_classify", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_format_id: FORMAT,
    p_match_key: UNKNOWN_KEY, p_category: "PENALTY", p_subcategory: "Hijack",
  }, rival)
  check("another business cannot classify this business's code", !outsider.ok && say(outsider).includes("could not be found"), say(outsider))

  const classified = await rpc("classification_rule_classify", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_format_id: FORMAT,
    p_match_key: UNKNOWN_KEY, p_category: "OTHER_MARKETPLACE_EXPENSE", p_subcategory: "Invented future fee", p_note: "Verification",
  }, owner)
  check("the owner classifies the unknown code for this business", classified.ok && typeof classified.body === "string", say(classified))

  const third = await summaryAs(owner)
  check(
    "FINAL now: contribution 69.0000 (74.00 - 5.00), nothing re-uploaded",
    third?.contribution === "69.0000" && third?.contribution_status === "FINAL" && third?.figures_status === "FINAL" &&
      third?.unknown_lines === 0 && third?.other_marketplace_costs === "-5.0000",
    JSON.stringify(third)
  )
  const stillThirteen = rows(await read(`/rest/v1/ledger_lines?select=id&source_file_id=eq.${fileId}`, owner))
  check("the ledger itself did not change: still the same 13 lines", stillThirteen.length === 13)
  check("Data Quality no longer lists the code", !(await quality()).some((i) => i.issue_kind === "UNKNOWN_CODE"))

  /* ------------------------------------------------------------------------ */
  section("5. A CORRECTION IS A NEW VERSION; RETIRING IT REOPENS THE CODE")

  const corrected = await rpc("classification_rule_classify", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_format_id: FORMAT,
    p_match_key: UNKNOWN_KEY, p_category: "PENALTY", p_subcategory: "Invented penalty",
  }, owner)
  check("the owner corrects the classification", corrected.ok, say(corrected))
  const versions = rows(await read(
    `/rest/v1/classification_rules?select=id,version,status,category&business_id=eq.${businessId}&match_key=eq.${encodeURIComponent(UNKNOWN_KEY)}&order=version`,
    owner
  ))
  check(
    "version 1 is retired, version 2 is active -- nothing was edited",
    versions.length === 2 && versions[0].status === "RETIRED" && versions[1].status === "ACTIVE" &&
      versions[1].version === 2 && versions[1].category === "PENALTY",
    JSON.stringify(versions)
  )
  const afterCorrection = rows(await rpc("pnl_breakdown", JULY, owner))
  check(
    "the correction reaches the figures at once: the line is now a penalty",
    afterCorrection.some((b) => b.category === "PENALTY" && b.total === "-5.0000") &&
      !afterCorrection.some((b) => b.category === "OTHER_MARKETPLACE_EXPENSE")
  )

  const nonRecoverable = await setVat("NON_RECOVERABLE")
  const fourth = await summaryAs(owner)
  check(
    "Non-recoverable: the VAT becomes an expense -- contribution 66.5000",
    nonRecoverable.ok && fourth?.contribution === "66.5000" && fourth?.non_recoverable_vat === "-2.5000",
    JSON.stringify(fourth)
  )

  await setVat("UNKNOWN")
  const fifth = await summaryAs(owner)
  check(
    "Unknown again: no final contribution; informational figure 69.0000",
    fifth?.contribution === null && JSON.stringify(fifth?.incomplete_reasons) === JSON.stringify(["VAT_TREATMENT_UNKNOWN"]) &&
      fifth?.contribution_before_open_items === "69.0000"
  )
  await setVat("RECOVERABLE")

  const retired = await rpc("classification_rule_retire", { p_rule_id: versions[1].id }, owner)
  const sixth = await summaryAs(owner)
  check(
    "retiring the business's classification makes the code Unknown again",
    retired.ok && sixth?.unknown_lines === 1 && sixth?.contribution === null,
    say(retired)
  )

  /* ------------------------------------------------------------------------ */
  section("6. NOBODY EDITS A RULE DIRECTLY; ANOTHER BUSINESS SEES NOTHING")

  const insert = await request("/rest/v1/classification_rules", {
    method: "POST",
    body: JSON.stringify({ scope: "BUSINESS", business_id: businessId, marketplace_code: "AMAZON", format_id: FORMAT,
      match_key: UNKNOWN_KEY, category: "PENALTY", subcategory: "direct", confidence: "HIGH", evidence: "direct" }),
  }, owner)
  check("a signed-in user cannot insert a rule directly", !insert.ok, say(insert))

  const edit = await request(
    `/rest/v1/classification_rules?business_id=is.null&match_key=eq.${encodeURIComponent("Order|ItemPrice|Principal")}`,
    { method: "PATCH", body: JSON.stringify({ category: "PENALTY" }) },
    owner
  )
  const principalRule = rows(await read(
    `/rest/v1/classification_rules?select=category&business_id=is.null&status=eq.ACTIVE&match_key=eq.${encodeURIComponent("Order|ItemPrice|Principal")}`,
    owner
  ))[0]
  check("nor edit a BizMind rule", !edit.ok && principalRule?.category === "PRODUCT_SALES", say(edit))

  check("another business gets no summary", (await summaryAs(rival)) === undefined)
  check("no breakdown", rows(await rpc("pnl_breakdown", JULY, rival)).length === 0)
  check("no data quality", rows(await rpc("ledger_data_quality", { p_account_id: accountId }, rival)).length === 0)
  check(
    "no classified lines, and not this business's own rules",
    rows(await read(`/rest/v1/ledger_classified_lines?select=id&source_file_id=eq.${fileId}`, rival)).length === 0 &&
      rows(await read(`/rest/v1/classification_rules?select=id&business_id=eq.${businessId}`, rival)).length === 0
  )
  check("nor an impact preview", rows(await rpc("classification_rule_impact", {
    p_business_id: businessId, p_marketplace_code: "AMAZON", p_format_id: FORMAT, p_match_key: UNKNOWN_KEY,
  }, rival)).length === 0)

  const anon = await rpc("pnl_summary", JULY, ANON_KEY)
  check("an anonymous caller cannot run the P&L engine", !anon.ok, say(anon))

  /* ------------------------------------------------------------------------ */
  section("7. A WITHDRAWN FILE COUNTS TOWARDS NOTHING")

  const withdrawn = await rpc("ledger_file_withdraw", { p_source_file_id: fileId, p_reason: "Verification" }, owner)
  check("withdrawn: no figures for July", withdrawn.ok && (await summaryAs(owner)) === undefined, say(withdrawn))
  const restored = await rpc("ledger_file_restore", { p_source_file_id: fileId }, owner)
  check("restored: the figures return", restored.ok && (await summaryAs(owner))?.gross_sales === "315.0000", say(restored))
} catch (error) {
  failed += 1
  console.log(`\n  FAIL  the suite stopped early: ${(error as Error).message}`)
} finally {
  const removed = await request(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" }, owner)
  check("deleting the business still works with its own classification rules", removed.ok, removed.ok ? "" : say(removed))

  console.log(`\n${"=".repeat(74)}`)
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log("=".repeat(74))
}

process.exit(failed === 0 ? 0 : 1)
