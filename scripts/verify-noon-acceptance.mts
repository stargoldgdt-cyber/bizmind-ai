/**
 * Acceptance: the owner's REAL noon July 2026 exports, through the whole path.
 *
 * Run with:
 *   npm run test:noon-acceptance -- "C:/path/transaction-view.csv" "C:/path/invoices.csv"
 *
 * Only the two files named are read, from where they are; they are never copied
 * into the repository, and nothing here names a party. A throwaway business is
 * created and deleted.
 *
 * The expected figures were worked out independently from the same files
 * (exact decimals, the Phase 5 classification) before this test was run.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"

import { requireConfig } from "./test-env.mjs"
import { parseFile } from "../src/services/ingestion/parse"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
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

const [tvPath, invoicesPath] = process.argv.slice(2)
if (!tvPath || !invoicesPath || !existsSync(tvPath) || !existsSync(invoicesPath)) {
  console.log("\n  SKIPPED  The real noon exports were not given.")
  console.log('  Run:  npm run test:noon-acceptance -- "C:/path/transaction-view.csv" "C:/path/invoices.csv"\n')
  process.exit(0)
}

const { url: SUPABASE_URL, anonKey: ANON_KEY, email: EMAIL, password: PASSWORD } = requireConfig()

type Json = ReturnType<typeof JSON.parse>

async function call(path: string, init: RequestInit, token: string) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: (text ? JSON.parse(text) : null) as Json }
}
const rpc = (fn: string, args: unknown, token: string) =>
  call(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, token)

async function signIn(): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  return (await response.json()).access_token
}

const token = await signIn()
const suffix = Date.now().toString(36)
const business = await rpc("create_business", { p_name: `Noon Acceptance ${suffix}`, p_slug: `noon-acceptance-${suffix}`, p_currency: "AED" }, token)
const businessId: string = business.body.id

async function upload(accountId: string, path: string) {
  const name = basename(path)
  const buffer = readFileSync(path)
  const parsed = await parseFile(buffer, name)
  if ("error" in parsed) throw new Error(parsed.error)
  const detection = marketplaceAdapters.detect({ fileName: name, headers: parsed.columns, rows: [] })
  if (detection.kind !== "match") throw new Error(`not a noon report (${detection.kind})`)
  const ruleRows: Json[] = (await call(
    `/rest/v1/ledger_mapping_rules?select=id,match_key,side,category,subcategory,attribution,quantity_rule,sign_rule&marketplace_code=eq.NOON&format_id=eq.${detection.format.id}&status=eq.ACTIVE`,
    { method: "GET" }, token
  )).body
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
  const applied = await rpc("ledger_apply_file", { p_file: built.payload }, token)
  return { applied, result, format: detection.format.id }
}

try {
  const account = await rpc("marketplace_account_create", {
    p_business_id: businessId, p_marketplace_code: "NOON", p_label: "noon UAE", p_country: "AE", p_currency: "AED",
  }, token)
  const accountId: string = account.body
  const period = { p_from: "2026-07-01T00:00:00Z", p_to: "2026-08-01T00:00:00Z", p_account_id: accountId }
  const summaryNow = async () => (await rpc("pnl_summary", period, token)).body?.[0]
  const setVat = (treatment: string) => rpc("tax_profile_set_input_vat", { p_account_id: accountId, p_treatment: treatment }, token)

  /* ------------------------------------------------------------------------ */
  section("1. THE TRANSACTION VIEW ALONE")

  const tv = await upload(accountId, tvPath)
  const tvOutcome = tv.applied.body?.[0]
  check("recognised as the noon Transaction View", tv.format === "noon.transaction_view.item_level")
  check(
    "recorded: 1,493 rows, 3,189 AED lines, 5 payouts, nothing unrecognised, nothing unreadable",
    tv.applied.ok && tvOutcome.rows_written === 1493 && tvOutcome.transactions_written === 3189 &&
      tvOutcome.payouts_written === 5 && tvOutcome.unmapped_written === 0 &&
      !tv.result.issues.some((i) => i.severity === "ERROR"),
    JSON.stringify(tvOutcome)
  )
  check(
    "the one SAR row is left for the SAR account, with a warning",
    tv.result.issues.length === 1 && tv.result.issues[0].severity === "WARNING" && tv.result.issues[0].message.includes("SAR")
  )
  const payouts: Json[] = (await call(`/rest/v1/ledger_payouts?select=amount&source_file_id=eq.${tvOutcome.source_file_id}&order=amount`, { method: "GET" }, token)).body
  check(
    "the five payments are the payouts noon reported",
    JSON.stringify(payouts.map((p) => p.amount)) === JSON.stringify(["18963.7700", "21179.4200", "23974.0200", "28072.6700", "32627.2000"]),
    JSON.stringify(payouts)
  )

  const tvOnly = await summaryNow()
  check("gross sales 153091.0800 (net proceeds 153,086.08 + shipping credits 5.00)", tvOnly?.gross_sales === "153091.0800", JSON.stringify(tvOnly))
  check("other income 12192.6200 (order subsidies)", tvOnly?.other_income === "12192.6200")
  check("fees -25244.5200, fulfilment -24206.3600, advertising -4392.2000 -- VAT inside", tvOnly?.marketplace_fees === "-25244.5200" &&
    tvOnly?.fulfillment === "-24206.3600" && tvOnly?.advertising === "-4392.2000")
  check(
    "not final: fee VAT is not separated yet",
    tvOnly?.contribution === null && JSON.stringify(tvOnly?.incomplete_reasons) === JSON.stringify(["FEE_VAT_NOT_SEPARATED"]),
    JSON.stringify(tvOnly?.incomplete_reasons)
  )
  check("informational figure 111440.6200", tvOnly?.contribution_before_open_items === "111440.6200")

  /* ------------------------------------------------------------------------ */
  section("2. WITH THE INVOICES")

  const inv = await upload(accountId, invoicesPath)
  const invOutcome = inv.applied.body?.[0]
  check("recognised as noon Invoices and Credit Notes", inv.format === "noon.invoices_credit_notes")
  check(
    "recorded: 955 rows, 999 lines (88 fee-VAT lines, 911 sales VAT lines), nothing unrecognised",
    inv.applied.ok && invOutcome.rows_written === 955 && invOutcome.transactions_written === 999 && invOutcome.unmapped_written === 0,
    JSON.stringify(invOutcome)
  )
  const storedText = JSON.stringify((await call(`/rest/v1/source_rows?select=raw&source_file_id=eq.${invOutcome.source_file_id}&limit=1000`, { method: "GET" }, token)).body)
  check(
    "no stored invoice row has a Receiver or Issuer name, tax number, city or location column",
    !/"(Receiver|Issuer) (Legal Name|Legal Entity|TRN|City|Location)"/.test(storedText) && !storedText.includes('"Receiver Country"')
  )

  const unknownVat = await summaryNow()
  check("fees -24439.7900 (VAT 804.73 taken out)", unknownVat?.marketplace_fees === "-24439.7900", JSON.stringify(unknownVat))
  check("fulfilment -22972.4600 (VAT and import VAT 1,233.90 taken out)", unknownVat?.fulfillment === "-22972.4600")
  check("advertising -4183.0500 (VAT 209.15 taken out)", unknownVat?.advertising === "-4183.0500")
  check("input VAT -2247.7800 waits for the setting", unknownVat?.input_vat_unresolved === "-2247.7800")
  check("output VAT -7051.2800 on the tax side only", unknownVat?.output_vat === "-7051.2800")
  check(
    "only the VAT setting remains open",
    JSON.stringify(unknownVat?.incomplete_reasons) === JSON.stringify(["VAT_TREATMENT_UNKNOWN"]) &&
      unknownVat?.contribution_before_open_items === "113688.4000",
    JSON.stringify(unknownVat?.incomplete_reasons)
  )
  check("132 lines are counted under review (medium-confidence noon codes)", unknownVat?.review_lines === 132, String(unknownVat?.review_lines))

  await setVat("RECOVERABLE")
  const recoverable = await summaryNow()
  check("Recoverable: FINAL contribution 113688.4000", recoverable?.contribution === "113688.4000" && recoverable?.contribution_status === "FINAL",
    JSON.stringify(recoverable))
  await setVat("NON_RECOVERABLE")
  const nonRecoverable = await summaryNow()
  check("Non-recoverable: contribution 111440.6200", nonRecoverable?.contribution === "111440.6200", JSON.stringify(nonRecoverable))

  const months: Json[] = (await rpc("pnl_periods", { p_business_id: businessId }, token)).body ?? []
  check("the dashboard offers July 2026 with 4,188 lines", months.some((m) => m.month === "2026-07-01" && m.lines === 4188), JSON.stringify(months))

  console.log("\n  info  For comparison with the owner's own July workings (which used noon's")
  console.log("        fee amounts including VAT and set 50 unattributed rows aside):")
  console.log("        owner: gross 153,086 · referral -24,999 · fulfilment -22,996 · subsidies +11,873")
  console.log("               · advertising + balance transfer -5,111 · contribution 111,613")
} catch (error) {
  failed += 1
  console.log(`\n  FAIL  stopped early: ${(error as Error).message}`)
} finally {
  const removed = await call(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" }, token)
  console.log(removed.ok ? "\n  The throwaway business and every row of the real files were deleted." : `\n  note: could not delete the throwaway business: ${JSON.stringify(removed.body)}`)
  console.log(`\n${"=".repeat(74)}`)
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log("=".repeat(74))
}

process.exit(failed === 0 ? 0 : 1)
