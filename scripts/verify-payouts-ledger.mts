/**
 * Expected marketplace payouts and cashflow, end to end against the real
 * database (migration 0039).
 *
 * Run with:  npm run test:payouts-ledger
 *
 * One INVENTED fixture month produces every marketplace-side status:
 *   ADDS_UP              an Amazon settlement whose total equals its lines
 *   DOES_NOT_ADD_UP      an Amazon settlement whose total does not
 *   NO_TOTAL             a settlement reported without a total
 *   MARKETPLACE_PAYMENT  a payment noon reports sending
 * and proves the owner's rule: an expected payout is never shown as received;
 * the bank side is NOT_CONNECTED on every row, and no bank data exists.
 */

import { createHash } from "node:crypto"

import ExcelJS from "exceljs"

import { requireConfig } from "./test-env.mjs"
import { parseFile } from "../src/services/ingestion/parse"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
import { AMAZON_V2_HEADERS } from "../src/services/marketplaces/amazon/flat-file-v2"
import type { MappingRuleSummary, NormalizeResult, SourceRow } from "../src/services/marketplaces/contract"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import { NOON_TV_HEADERS } from "../src/services/marketplaces/noon/transaction-view"
import { aboutLines, payoutSheets } from "../src/services/reports/catalog"
import { reportWorkbook } from "../src/services/reports/xlsx"

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
const SID = (n: number) => `9${n}${RUN}`

const tsv = (fields: Partial<Record<(typeof AMAZON_V2_HEADERS)[number], string>>) =>
  AMAZON_V2_HEADERS.map((header) => fields[header] ?? "").join("\t")

function amazonSettlement(sid: string, total: string, deposit: string, lines: [string, string, string][]): string {
  return [
    AMAZON_V2_HEADERS.join("\t"),
    tsv({ "settlement-id": sid, "settlement-start-date": "01.07.2026 00:00:00 UTC", "settlement-end-date": "14.07.2026 00:00:00 UTC",
      "deposit-date": deposit, "total-amount": total, currency: "AED" }),
    ...lines.map(([description, amountType, amount], i) => tsv({
      "settlement-id": sid, "transaction-type": "Order", "order-id": `999-${sid}-${i}`,
      "merchant-order-id": `999-${sid}-${i}`, "marketplace-name": "Amazon.ae", "amount-type": amountType,
      "amount-description": description, amount, "fulfillment-id": "AFN", "posted-date": "05.07.2026",
      "posted-date-time": "05.07.2026 10:00:00 UTC", "order-item-code": `7${sid}`, sku: "PAYOUT-SKU",
      "quantity-purchased": "1",
    })),
  ].join("\n") + "\n"
}

// ADDS_UP: 100 - 10 = 90, total 90.
const ADDS_UP = amazonSettlement(SID(1), "90.00", "18.07.2026 00:00:00 UTC", [["Principal", "ItemPrice", "100.00"], ["Commission", "ItemFees", "-10.00"]])
// DOES_NOT_ADD_UP: 50 - 10 = 40, total 50.
const MISMATCH = amazonSettlement(SID(2), "50.00", "25.07.2026 00:00:00 UTC", [["Principal", "ItemPrice", "50.00"], ["Commission", "ItemFees", "-10.00"]])
// NO_TOTAL: read as Amazon, then reported without a total (as a marketplace that states none would).
const NO_TOTAL = amazonSettlement(SID(3), "20.00", "28.07.2026 00:00:00 UTC", [["Principal", "ItemPrice", "20.00"]])

const TV_MONEY = new Set([
  "Net Proceeds", "Referral Fee including VAT", "Fullfilment & Logistics Fees including VAT",
  "Shipping Credits including VAT", "Other Order Fees including VAT", "Order Subsidies including VAT",
  "Non-Order Fees including VAT", "Non-Order Subsidies including VAT", "Others including VAT", "Total",
])
const csvLine = (values: string[]) => values.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")
const ae = { Contract: `MP${RUN}AE`, "Contract Title": "NOON-AE", Currency: "AED" }
const NOON_FILE = [
  csvLine([...NOON_TV_HEADERS]),
  ...[
    { ...ae, "Transaction Date": "2026-07-04", "Order Nr": `NAEI${RUN}1`, "Item Nr": `NAEI${RUN}1-1`, "Partner SKUs": "N-SKU",
      "Transaction Type": "order", "Net Proceeds": "100", Total: "100" },
    { ...ae, "Transaction Date": "2026-07-10", "Order Nr": "NA", Title: "Payment Disbursal", "Transaction Type": "payment",
      "Reference Nr": `2026-07-10 ${RUN} Bank Transfer`, "Others including VAT": "-60", Total: "-60" },
    { ...ae, "Transaction Date": "2026-08-03", "Order Nr": "NA", Title: "Payment Disbursal", "Transaction Type": "payment",
      "Reference Nr": `2026-08-03 ${RUN} Bank Transfer`, "Others including VAT": "-15.5", Total: "-15.5" },
  ].map((r: Record<string, string>) => csvLine(NOON_TV_HEADERS.map((h) => r[h] ?? (TV_MONEY.has(h) ? "0" : "")))),
].join("\n") + "\n"

/* ---- setup ------------------------------------------------------------------ */

section("Setup -- a throwaway business with an Amazon and a noon account")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)

const created = await rpc("create_business", { p_name: `Payouts Verify ${suffix}`, p_slug: `payouts-verify-${suffix}`, p_currency: "AED" }, owner)
if (!created.ok) {
  console.log(`  could not create the business: ${say(created)}`)
  process.exit(1)
}
const businessId: string = created.body.id

async function upload(
  accountId: string,
  code: "AMAZON" | "NOON",
  name: string,
  content: string,
  adjust?: (result: NormalizeResult) => NormalizeResult
): Promise<Reply> {
  const buffer = Buffer.from(content, "utf8")
  const parsed = await parseFile(buffer, name)
  if ("error" in parsed) throw new Error(parsed.error)
  const detection = marketplaceAdapters.detect({ fileName: name, headers: parsed.columns, rows: [] })
  if (detection.kind !== "match") throw new Error(`${name}: not recognised`)
  const ruleRows = rows(await read(
    `/rest/v1/ledger_mapping_rules?select=id,match_key,side,category,subcategory,attribution,quantity_rule,sign_rule&marketplace_code=eq.${code}&format_id=eq.${detection.format.id}&status=eq.ACTIVE`,
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
  const normalized = detection.adapter.normalize({
    formatId: detection.format.id, rows: sourceRows, rules, account: { id: accountId, marketplaceCode: code, currency: "AED" },
  })
  const result = adjust ? adjust(normalized) : normalized
  const built = buildLedgerFilePayload({
    accountId, accountCurrency: "AED", format: detection.format,
    file: { name, type: name.endsWith(".txt") ? "txt" : "csv", sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") },
    columns: parsed.columns, rows: sourceRows, result,
  })
  if (!built.ok) throw new Error(`${name}: ${built.problems.join(" | ")}`)
  return rpc("ledger_apply_file", { p_file: built.payload }, owner)
}

try {
  const makeAccount = async (code: "AMAZON" | "NOON", label: string) => {
    const reply = await rpc("marketplace_account_create", {
      p_business_id: businessId, p_marketplace_code: code, p_label: label, p_country: "AE", p_currency: "AED",
    }, owner)
    if (!reply.ok) throw new Error(`Could not create ${label}: ${say(reply)}`)
    return reply.body as string
  }
  const amazon = await makeAccount("AMAZON", "Amazon.ae")
  const noon = await makeAccount("NOON", "noon UAE")

  const a1 = await upload(amazon, "AMAZON", `${SID(1)}.txt`, ADDS_UP)
  const a2 = await upload(amazon, "AMAZON", `${SID(2)}.txt`, MISMATCH)
  const a3 = await upload(amazon, "AMAZON", `${SID(3)}.txt`, NO_TOTAL, (result) => ({
    ...result,
    settlements: result.settlements.map((s) => ({ ...s, reportedTotal: null })),
    payouts: [],
  }))
  const n1 = await upload(noon, "NOON", `noon-tv-${RUN}.csv`, NOON_FILE)
  check("the fixture month is recorded (three settlements, one noon export)", a1.ok && a2.ok && a3.ok && n1.ok,
    [a1, a2, a3, n1].filter((r) => !r.ok).map(say).join(" | "))
  const mismatchFile: string = rows(a2)[0]?.source_file_id

  const JULY = { p_business_id: businessId, p_from: "2026-07-01T00:00:00Z", p_to: "2026-08-01T00:00:00Z" }

  /* ------------------------------------------------------------------------ */
  section("1. EVERY STATUS, FROM ONE FIXTURE MONTH")

  const july = rows(await rpc("expected_payouts", JULY, owner))
  const byRef = new Map(july.map((p) => [p.reference, p]))
  const statuses = [...new Set(july.map((p) => p.marketplace_status))].sort()
  check(
    "July produces all four statuses",
    JSON.stringify(statuses) === JSON.stringify(["ADDS_UP", "DOES_NOT_ADD_UP", "MARKETPLACE_PAYMENT", "NO_TOTAL"]),
    JSON.stringify(july.map((p) => [p.reference, p.marketplace_status]))
  )
  const s1 = byRef.get(SID(1))
  check(
    "ADDS_UP: expected payout 90.0000 on the deposit date, from the settlement report",
    s1?.marketplace_status === "ADDS_UP" && s1?.expected_amount === "90.0000" && s1?.settlement_lines_total === "90.0000" &&
      s1?.source === "SETTLEMENT_REPORT" && String(s1?.expected_date).startsWith("2026-07-18"),
    JSON.stringify(s1)
  )
  const s2 = byRef.get(SID(2))
  check(
    "DOES_NOT_ADD_UP: expected 50.0000 but its lines add up to 40.0000",
    s2?.marketplace_status === "DOES_NOT_ADD_UP" && s2?.expected_amount === "50.0000" && s2?.settlement_lines_total === "40.0000",
    JSON.stringify(s2)
  )
  const s3 = byRef.get(SID(3))
  check(
    "NO_TOTAL: no expected amount is invented",
    s3?.marketplace_status === "NO_TOTAL" && s3?.expected_amount === null && s3?.settlement_lines_total === "20.0000",
    JSON.stringify(s3)
  )
  const payment = july.find((p) => p.source === "MARKETPLACE_PAYMENT_REPORT")
  check(
    "MARKETPLACE_PAYMENT: noon's payment of 60.0000 on 10 July, with no settlement",
    payment?.marketplace_status === "MARKETPLACE_PAYMENT" && payment?.expected_amount === "60.0000" &&
      payment?.account_label === "noon UAE" && String(payment?.expected_date).startsWith("2026-07-10") &&
      payment?.settlement_lines_total === null,
    JSON.stringify(payment)
  )

  /* ------------------------------------------------------------------------ */
  section("2. EXPECTED IS NEVER RECEIVED")

  check(
    "every row's bank side is NOT_CONNECTED, with no amount and no date",
    july.length === 4 && july.every((p) => p.bank_receipt_status === "NOT_CONNECTED" && p.bank_receipt_amount === null &&
      p.bank_receipt_date === null),
    JSON.stringify(july.map((p) => [p.bank_receipt_status, p.bank_receipt_amount]))
  )
  const bankTable = await read("/rest/v1/bank_transactions?select=id&limit=1", owner)
  check("no bank transaction table exists to hold invented receipts", !bankTable.ok, say(bankTable))

  const cashflow = rows(await rpc("expected_cashflow", { p_business_id: businessId }, owner))
  const julyFlow = cashflow.find((c) => c.month === "2026-07-01")
  check(
    "July's expected inflow is 200.0000 (90 + 50 + 60; the settlement without a total adds nothing)",
    julyFlow?.expected_payouts === 4 && julyFlow?.expected_inflow === "200.0000" &&
      julyFlow?.payouts_without_amount === 1,
    JSON.stringify(julyFlow)
  )
  check(
    "50.0000 of it is in doubt (the settlement that does not add up)",
    julyFlow?.payouts_in_doubt === 1 && julyFlow?.amount_in_doubt === "50.0000"
  )
  check(
    "and nothing is claimed as received",
    cashflow.every((c) => c.bank_receipt_status === "NOT_CONNECTED" && c.bank_received === null)
  )
  const augustFlow = cashflow.find((c) => c.month === "2026-08-01")
  check("noon's August payment lands in August: 15.5000", augustFlow?.expected_inflow === "15.5000", JSON.stringify(cashflow))

  /* ------------------------------------------------------------------------ */
  section("3. THE PAYOUTS REPORT, FROM THE REAL READERS")

  const workbookBuffer = await reportWorkbook({
    key: "payouts",
    title: "Expected payouts and cashflow",
    about: aboutLines({ businessName: "Payouts Verify", period: "July 2026", generatedAt: "now" }),
    sheets: payoutSheets(july, cashflow),
  })
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(workbookBuffer as unknown as ArrayBuffer)
  const sheet = book.getWorksheet("Expected payouts")!
  const heads = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1)
  const col = (label: string) => heads.indexOf(label) + 1
  const written = Array.from({ length: sheet.rowCount - 1 }, (_, i) => sheet.getRow(i + 2))
  const amountOf = (ref: string) => written.find((r) => r.getCell(col("Reference")).value === ref)?.getCell(col("Expected marketplace payout")).value
  check(
    "the workbook holds each expected payout exactly, and a blank where there is none",
    written.length === 4 && amountOf(SID(1)) === 90 && amountOf(SID(2)) === 50 && amountOf(SID(3)) === null,
    JSON.stringify(written.map((r) => r.values))
  )
  check(
    "and every row's bank column reads Not connected",
    written.every((r) => r.getCell(col("Actual bank receipt")).value === "Not connected")
  )

  /* ------------------------------------------------------------------------ */
  section("4. FILTERS, WITHDRAWAL, ISOLATION")

  const noonOnly = rows(await rpc("expected_payouts", { ...JULY, p_account_id: noon }, owner))
  check("one account's payouts only", noonOnly.length === 1 && noonOnly[0].account_label === "noon UAE")
  const everything = rows(await rpc("expected_payouts", { p_business_id: businessId }, owner))
  check("without a period, every expected payout (5)", everything.length === 5, String(everything.length))

  const withdrawn = await rpc("ledger_file_withdraw", { p_source_file_id: mismatchFile, p_reason: "Verification" }, owner)
  const afterWithdraw = rows(await rpc("expected_payouts", JULY, owner))
  check(
    "a withdrawn settlement file no longer counts",
    withdrawn.ok && afterWithdraw.length === 3 && !afterWithdraw.some((p) => p.reference === SID(2)),
    say(withdrawn)
  )
  const flowAfter = rows(await rpc("expected_cashflow", { p_business_id: businessId }, owner)).find((c) => c.month === "2026-07-01")
  check("July's expected inflow follows: 150.0000, nothing in doubt",
    flowAfter?.expected_inflow === "150.0000" && flowAfter?.payouts_in_doubt === 0, JSON.stringify(flowAfter))

  check("another business sees no expected payouts, even naming this business",
    rows(await rpc("expected_payouts", { p_business_id: businessId }, rival)).length === 0)
  check("nor its cashflow", rows(await rpc("expected_cashflow", { p_business_id: businessId }, rival)).length === 0)
  const anon = await request("/rest/v1/rpc/expected_payouts", {
    method: "POST", body: JSON.stringify({ p_business_id: businessId }),
  }, ANON_KEY)
  check("a signed-out caller cannot read them", !anon.ok, say(anon))
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
