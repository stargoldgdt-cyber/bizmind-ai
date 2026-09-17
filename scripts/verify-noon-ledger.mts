/**
 * noon, end to end against the real database (migration 0034).
 *
 * Run with:  npm run test:noon-ledger
 *
 * INVENTED noon exports (the real reports' shape, no real data) go through the
 * real upload path. Then:
 *   - every known line is classified automatically; fees include VAT, so
 *     contribution is incomplete until the invoices separate it
 *   - the invoices take the VAT out of the fees; the VAT setting decides the rest
 *   - an overlapping export is refused on upload and on restore
 *   - two AED accounts add up in the combined view
 *   - no party's name is stored; another business sees nothing
 */

import { createHash } from "node:crypto"

import { requireConfig } from "./test-env.mjs"
import { parseFile } from "../src/services/ingestion/parse"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
import type { MappingRuleSummary, SourceRow } from "../src/services/marketplaces/contract"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import { NOON_INVOICE_HEADERS } from "../src/services/marketplaces/noon/invoices"
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
const TV_MONEY = new Set([
  "Net Proceeds", "Referral Fee including VAT", "Fullfilment & Logistics Fees including VAT",
  "Shipping Credits including VAT", "Other Order Fees including VAT", "Order Subsidies including VAT",
  "Non-Order Fees including VAT", "Non-Order Subsidies including VAT", "Others including VAT", "Total",
])

function csv(headers: readonly string[], records: Record<string, string>[], defaultFor: (h: string) => string): string {
  const line = (values: string[]) => values.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")
  return [line([...headers]), ...records.map((r) => line(headers.map((h) => r[h] ?? defaultFor(h))))].join("\n") + "\n"
}
const tvCsv = (records: Record<string, string>[]) => csv(NOON_TV_HEADERS, records, (h) => (TV_MONEY.has(h) ? "0" : ""))
const invCsv = (records: Record<string, string>[]) => csv(NOON_INVOICE_HEADERS, records, () => "")

const ae = { Contract: `MP${RUN}AE`, "Contract Title": "NOON-AE", "Transaction Date": "2026-07-04", Currency: "AED" }
const R1 = { ...ae, "Order Nr": `NAEI${RUN}1`, "Item Nr": `NAEI${RUN}1-1`, "Partner SKUs": "SKU-A", "Transaction Type": "order",
  "Net Proceeds": "100", "Referral Fee including VAT": "-10.50", "Fullfilment & Logistics Fees including VAT": "-5.25",
  "Order Subsidies including VAT": "2", Total: "86.25" }
const R2 = { ...ae, "Order Nr": `NAEI${RUN}1`, "Transaction Type": "order", "Fullfilment & Logistics Fees including VAT": "-3.15", Total: "-3.15" }
const R3 = { ...ae, "Order Nr": `NAEI${RUN}1`, "Item Nr": `NAEI${RUN}1-1`, "Transaction Type": "order_update",
  "Net Proceeds": "-20", "Referral Fee including VAT": "2.10", Total: "-17.90" }
const R4 = { ...ae, "Order Nr": "NA", Title: "Advertising Fee", "Transaction Type": "statement_fee", "Reference Nr": `PS-${RUN}-AE20260708`,
  "Non-Order Fees including VAT": "-21", Total: "-21" }
const R5 = { ...ae, "Order Nr": "NA", Title: "Payment Disbursal", "Transaction Type": "payment", "Reference Nr": `2026-07-10 ${RUN} Bank Transfer`,
  "Others including VAT": "-60", Total: "-60" }
const R6 = { ...ae, "Order Nr": "NA", Title: `MP${RUN}-2026-07-30`, "Transaction Type": "balance_transfer", "Others including VAT": "-1", Total: "-1" }
const R7 = { ...ae, Currency: "SAR", "Contract Title": "Noon SA (Origin AE)", "Order Nr": "NA", "Transaction Type": "balance_transfer",
  "Others including VAT": "-0.50", Total: "-0.50" }
const R8 = { ...ae, "Order Nr": `NAEI${RUN}2`, "Item Nr": `NAEI${RUN}2-1`, "Transaction Type": "order", "Others including VAT": "-4", Total: "-4" }
const UNKNOWN_KEY = "order|Others including VAT|item"

const TV_FILE = tvCsv([R1, R2, R3, R4, R5, R6, R7, R8])
const OVERLAP_FILE = tvCsv([R1, { ...ae, "Order Nr": `NAEI${RUN}9`, "Item Nr": `NAEI${RUN}9-1`, "Transaction Type": "order", "Net Proceeds": "7", Total: "7" }])
const SECOND_STORE_FILE = tvCsv([{ ...ae, Contract: `MP${RUN}B`, "Order Nr": `NAEI${RUN}5`, "Item Nr": `NAEI${RUN}5-1`,
  "Transaction Type": "order", "Net Proceeds": "10", "Referral Fee including VAT": "-1", Total: "9" }])

const feeRow = (name: string, vat: string, included: string) => ({
  "Document Type": "Invoice", "Transaction Type": "Statement Fee", "Document Date": "2026-07-08", "Document Currency": "AED",
  Description: `PS-${RUN}-AE20260708 : ${name}`, "VAT Amount (Document Currency)": vat, "Price Including VAT (Document Currency)": included,
  "Receiver Legal Name": "Invented Seller LLC", "Receiver TRN": "100000000000003", "Source Doc Line Nr": `PS-${RUN}/${name}`,
})
const INVOICE_FILE = invCsv([
  feeRow("Referral Fee", "0.40", "8.40"),
  feeRow("Advertising Fee", "1.00", "21.00"),
  feeRow("FBN Outbound Fee", "0.40", "8.40"),
  feeRow("Import VAT Recovery", "0", "1.00"),
  { "Document Type": "Invoice", "Transaction Type": "Customer", "Document Date": "2026-07-05", "Document Currency": "AED",
    "VAT Amount (Document Currency)": "4.76", "Price Including VAT (Document Currency)": "100", "Source Doc Nr": `NAEI${RUN}1`,
    "Receiver Legal Name": "Invented Buyer", "Receiver City": "Invented City" },
  { "Document Type": "Creditnote", "Transaction Type": "Customer", "Document Date": "2026-07-06", "Document Currency": "AED",
    "VAT Amount (Document Currency)": "0.95", "Price Including VAT (Document Currency)": "20", "Source Doc Nr": `NAEI${RUN}1` },
])

/* ---- setup ------------------------------------------------------------------ */

section("Setup -- a throwaway business with two noon AED accounts")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)

const created = await rpc("create_business", { p_name: `Noon Verify ${suffix}`, p_slug: `noon-verify-${suffix}`, p_currency: "AED" }, owner)
if (!created.ok) {
  console.log(`  could not create the business: ${say(created)}`)
  process.exit(1)
}
const businessId: string = created.body.id

async function upload(accountId: string, name: string, content: string): Promise<Reply & { issues?: number }> {
  const buffer = Buffer.from(content, "utf8")
  const parsed = await parseFile(buffer, name)
  if ("error" in parsed) throw new Error(parsed.error)
  const detection = marketplaceAdapters.detect({ fileName: name, headers: parsed.columns, rows: [] })
  if (detection.kind !== "match") throw new Error(`${name}: not recognised (${detection.kind})`)
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
  if (!built.ok) throw new Error(`${name}: ${built.problems.join(" | ")}`)
  return rpc("ledger_apply_file", { p_file: built.payload }, owner)
}

try {
  const makeAccount = async (label: string, ref: string | null) => {
    const reply = await rpc("marketplace_account_create", {
      p_business_id: businessId, p_marketplace_code: "NOON", p_label: label, p_country: "AE", p_currency: "AED",
      p_external_seller_ref: ref,
    }, owner)
    if (!reply.ok) throw new Error(`Could not create ${label}: ${say(reply)}`)
    return reply.body as string
  }
  const accountA = await makeAccount("noon UAE", null)
  const accountB = await makeAccount("noon UAE second store", "second-store")

  const JULY = { p_from: "2026-07-01T00:00:00Z", p_to: "2026-08-01T00:00:00Z", p_account_id: accountA }
  const summary = async () => rows(await rpc("pnl_summary", JULY, owner))[0]
  const setVat = (account: string, treatment: string) =>
    rpc("tax_profile_set_input_vat", { p_account_id: account, p_treatment: treatment }, owner)

  /* ------------------------------------------------------------------------ */
  section("1. NOON IS AVAILABLE, WITH ITS RULES")

  const noon = rows(await read("/rest/v1/marketplaces?select=adapter_status&code=eq.NOON", owner))[0]
  check("noon is AVAILABLE", noon?.adapter_status === "AVAILABLE", JSON.stringify(noon))
  const noonRules = rows(await read("/rest/v1/classification_rules?select=id&marketplace_code=eq.NOON&business_id=is.null&status=eq.ACTIVE", owner))
  check("61 noon classification rules are active", noonRules.length === 61, String(noonRules.length))

  /* ------------------------------------------------------------------------ */
  section("2. THE TRANSACTION VIEW: FEES INCLUDE VAT, SO CONTRIBUTION WAITS")

  const tv = await upload(accountA, `noon-tv-${RUN}.csv`, TV_FILE)
  const tvOutcome = rows(tv)[0]
  check("recorded: 8 rows, 11 lines (4+1+2+1+1+1, the SAR row none, 1 unknown), 1 payout", tv.ok && tvOutcome.rows_written === 8 &&
    tvOutcome.transactions_written === 11 && tvOutcome.payouts_written === 1 && tvOutcome.unmapped_written === 1, say(tv))
  const tvFile: string = tvOutcome.source_file_id

  const first = await summary()
  check("gross sales 80.0000 (100 sold, -20 in an order update)", first?.gross_sales === "80.0000", JSON.stringify(first))
  check("other income 2.0000 (the subsidy)", first?.other_income === "2.0000")
  check("fees -8.4000 and fulfilment -8.4000, VAT still inside", first?.marketplace_fees === "-8.4000" && first?.fulfillment === "-8.4000")
  check("advertising -21.0000", first?.advertising === "-21.0000")
  check(
    "INCOMPLETE: an unknown code and fee VAT not separated -- nothing about the VAT setting yet",
    first?.contribution === null && JSON.stringify(first?.incomplete_reasons) === JSON.stringify(["UNKNOWN_LINES", "FEE_VAT_NOT_SEPARATED"]),
    JSON.stringify(first?.incomplete_reasons)
  )
  check("informational figure 44.2000", first?.contribution_before_open_items === "44.2000")
  check(
    "the order update and the balance transfer are counted under review (2 lines, -21.0000)",
    first?.review_lines === 2 && first?.review_amount === "-21.0000", `${first?.review_lines} ${first?.review_amount}`
  )

  const quality = rows(await rpc("ledger_data_quality", { p_account_id: accountA }, owner))
  check(
    "Data Quality names July as the month whose fees still include VAT",
    quality.some((i) => i.issue_kind === "FEE_VAT_NOT_SEPARATED" && i.reference === "2026-07"),
    JSON.stringify(quality.map((i) => i.issue_kind))
  )
  const payouts = rows(await read(`/rest/v1/ledger_payouts?select=amount,paid_at&source_file_id=eq.${tvFile}`, owner))
  check("the payment is recorded as a reported payout of 60.0000", payouts.length === 1 && payouts[0].amount === "60.0000", JSON.stringify(payouts))
  const tvIssues = rows(await read(`/rest/v1/import_issues?select=severity,message&batch_id=eq.${tvFile}`, owner))
  check(
    "the SAR row is a warning naming the other contract, not an error",
    tvIssues.some((i) => i.severity === "WARNING" && String(i.message).includes("SAR")) && !tvIssues.some((i) => i.severity === "ERROR")
  )

  await setVat(accountA, "NON_RECOVERABLE")
  const nonRecoverableFirst = await summary()
  check(
    "with VAT Non-recoverable, fees including VAT are already the right cost: only the unknown code remains",
    JSON.stringify(nonRecoverableFirst?.incomplete_reasons) === JSON.stringify(["UNKNOWN_LINES"]),
    JSON.stringify(nonRecoverableFirst?.incomplete_reasons)
  )
  await setVat(accountA, "UNKNOWN")

  /* ------------------------------------------------------------------------ */
  section("3. THE INVOICES TAKE THE VAT BACK OUT")

  const invoices = await upload(accountA, `noon-invoices-${RUN}.csv`, INVOICE_FILE)
  const invOutcome = rows(invoices)[0]
  check("recorded: 6 rows, 10 lines (two per fee, one per sales document)", invoices.ok && invOutcome.transactions_written === 10, say(invoices))
  const invFile: string = invOutcome.source_file_id

  const second = await summary()
  check("fees -8.0000: 0.40 of VAT taken out", second?.marketplace_fees === "-8.0000", JSON.stringify(second))
  check("fulfilment -7.0000: 0.40 of VAT and 1.00 of import VAT taken out", second?.fulfillment === "-7.0000")
  check("advertising -20.0000", second?.advertising === "-20.0000")
  check("input VAT -2.8000 waits for the VAT setting", second?.input_vat_unresolved === "-2.8000")
  check("output VAT -3.8100 (owed 4.76, given back 0.95), on the tax side only", second?.output_vat === "-3.8100")
  check(
    "fee VAT is separated now; the VAT setting and the unknown code remain",
    JSON.stringify(second?.incomplete_reasons) === JSON.stringify(["UNKNOWN_LINES", "VAT_TREATMENT_UNKNOWN"]),
    JSON.stringify(second?.incomplete_reasons)
  )
  check("informational figure 47.0000", second?.contribution_before_open_items === "47.0000")

  const stored = rows(await read(`/rest/v1/source_rows?select=raw&source_file_id=eq.${invFile}`, owner))
  const storedText = JSON.stringify(stored)
  check(
    "no stored invoice row carries a name, tax number or city",
    stored.length === 6 && !storedText.includes("Invented") && !storedText.includes("100000000000003") &&
      !storedText.includes("Receiver Legal Name")
  )

  /* ------------------------------------------------------------------------ */
  section("4. CLASSIFY THE UNKNOWN CODE; THE VAT SETTING DECIDES THE REST")

  const classified = await rpc("classification_rule_classify", {
    p_business_id: businessId, p_marketplace_code: "NOON", p_format_id: "noon.transaction_view.item_level",
    p_match_key: UNKNOWN_KEY, p_category: "OTHER_MARKETPLACE_EXPENSE", p_subcategory: "Other charges", p_note: "Verification",
  }, owner)
  check("the owner classifies the unknown noon code", classified.ok, say(classified))

  await setVat(accountA, "RECOVERABLE")
  const recoverable = await summary()
  check(
    "Recoverable: FINAL contribution 43.0000 (47.00 - 4.00)",
    recoverable?.contribution === "43.0000" && recoverable?.contribution_status === "FINAL",
    JSON.stringify(recoverable)
  )
  await setVat(accountA, "NON_RECOVERABLE")
  const nonRecoverable = await summary()
  check(
    "Non-recoverable: contribution 40.2000 (the 2.80 of VAT is a cost)",
    nonRecoverable?.contribution === "40.2000" && nonRecoverable?.non_recoverable_vat === "-2.8000",
    JSON.stringify(nonRecoverable)
  )

  /* ------------------------------------------------------------------------ */
  section("5. OVERLAPPING EXPORTS ARE NEVER COUNTED TWICE")

  const again = await upload(accountA, `noon-tv-${RUN}.csv`, TV_FILE)
  check("the same file again writes nothing", again.ok && rows(again)[0]?.duplicate === true, say(again))
  const overlap = await upload(accountA, `noon-tv-overlap-${RUN}.csv`, OVERLAP_FILE)
  check(
    "a different export repeating a counted row is refused, naming the file",
    !overlap.ok && say(overlap).includes("This file repeats 1 row(s)") && say(overlap).includes(`noon-tv-${RUN}.csv`),
    say(overlap)
  )

  const withdrawn = await rpc("ledger_file_withdraw", { p_source_file_id: tvFile, p_reason: "Verification" }, owner)
  const overlapNow = await upload(accountA, `noon-tv-overlap-${RUN}.csv`, OVERLAP_FILE)
  check("once that file is withdrawn, the overlapping export is accepted", withdrawn.ok && overlapNow.ok, say(overlapNow))
  const overlapFile: string = rows(overlapNow)[0]?.source_file_id

  const restoreRefused = await rpc("ledger_file_restore", { p_source_file_id: tvFile }, owner)
  check(
    "and the withdrawn file cannot come back while its rows count elsewhere",
    !restoreRefused.ok && say(restoreRefused).includes("rows are already counted"),
    say(restoreRefused)
  )
  await rpc("ledger_file_withdraw", { p_source_file_id: overlapFile, p_reason: "Verification" }, owner)
  const restored = await rpc("ledger_file_restore", { p_source_file_id: tvFile }, owner)
  check("after withdrawing the other file, it can", restored.ok, say(restored))

  /* ------------------------------------------------------------------------ */
  section("6. TWO AED ACCOUNTS ADD UP; NOTHING CROSSES BUSINESSES")

  const secondStore = await upload(accountB, `noon-tv-second-${RUN}.csv`, SECOND_STORE_FILE)
  check("the second store's export is recorded", secondStore.ok, say(secondStore))

  const combined = rows(await rpc("pnl_summary", {
    p_from: JULY.p_from, p_to: JULY.p_to, p_business_id: businessId, p_combine_by_currency: true,
  }, owner))
  const total = combined[0]
  check(
    "one AED total across both accounts: gross 90.0000, 2 accounts, no account id",
    combined.length === 1 && total.currency === "AED" && total.accounts === 2 && total.gross_sales === "90.0000" &&
      total.marketplace_account_id === null && total.account_label === "All AED accounts",
    JSON.stringify(combined)
  )
  check(
    "it is incomplete because the second store's fee VAT is not separated, and the VAT settings differ",
    total.contribution === null && total.incomplete_reasons.includes("FEE_VAT_NOT_SEPARATED") && total.input_vat_treatment === "MIXED",
    JSON.stringify(total)
  )
  const perAccount = rows(await rpc("pnl_summary", { p_from: JULY.p_from, p_to: JULY.p_to, p_business_id: businessId }, owner))
  check("and each account can be shown beside it", perAccount.length === 2 && perAccount.every((r) => r.accounts === 1))

  check(
    "another business sees no noon figures, even naming this business",
    rows(await rpc("pnl_summary", { p_from: JULY.p_from, p_to: JULY.p_to, p_business_id: businessId, p_combine_by_currency: true }, rival)).length === 0 &&
      rows(await rpc("pnl_summary", JULY, rival)).length === 0
  )
  check(
    "nor its stored rows",
    rows(await read(`/rest/v1/source_rows?select=id&source_file_id=eq.${invFile}`, rival)).length === 0
  )
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
