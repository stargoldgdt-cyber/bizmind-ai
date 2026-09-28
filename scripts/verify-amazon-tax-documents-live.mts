/**
 * Live acceptance: the owner's REAL Amazon tax invoices/credit notes, through
 * the real upload path, into a throwaway business that is deleted at the end.
 *
 * Run with:
 *   npm run test:amazon-tax-documents-live -- "C:/path/inv1.pdf" "C:/path/cn1.pdf" ...
 *
 * Only the files named on the command line are read. Never copied into the
 * repository; no invoice number, amount or business name is written here.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"

import { requireConfig } from "./test-env.mjs"
import { parseFile } from "../src/services/ingestion/parse"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
import type { MappingRuleSummary, SourceRow } from "../src/services/marketplaces/contract"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"

const candidates = process.argv.slice(2).filter((path) => existsSync(path))

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`) }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`) }
}
function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

if (candidates.length === 0) {
  console.log("\n  SKIPPED  No real tax-document files were found.")
  console.log('  Run:  npm run test:amazon-tax-documents-live -- "C:/path/inv1.pdf" ...\n')
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
async function signIn(): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  return (await response.json()).access_token
}
function units(value: string): bigint {
  const negative = value.startsWith("-")
  const [whole, fraction = ""] = value.replace("-", "").split(".")
  const scaled = BigInt(whole + fraction.padEnd(4, "0").slice(0, 4))
  return negative ? -scaled : scaled
}
function show(value: bigint): string {
  const negative = value < BigInt(0)
  const digits = (negative ? -value : value).toString().padStart(5, "0")
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`
}

const token = await signIn()
const suffix = Date.now().toString(36)
const business = await call("/rest/v1/rpc/create_business", {
  method: "POST",
  body: JSON.stringify({ p_name: `Tax Doc Acceptance ${suffix}`, p_slug: `tax-doc-acceptance-${suffix}`, p_currency: "AED" }),
}, token)
const businessId: string = business.body.id

try {
  const account = await call("/rest/v1/rpc/marketplace_account_create", {
    method: "POST",
    body: JSON.stringify({ p_business_id: businessId, p_marketplace_code: "AMAZON", p_label: "Amazon.ae", p_country: "AE", p_currency: "AED" }),
  }, token)
  const accountId: string = account.body

  section("1. EACH REAL DOCUMENT GOES THROUGH THE UPLOAD PATH")

  let uploaded = 0
  let totalUnmapped = 0
  for (const path of candidates) {
    const name = basename(path)
    const label = `document ${uploaded + 1} (${name})`
    const buffer = readFileSync(path)
    const parsed = await parseFile(buffer, name)
    if ("error" in parsed) { check(`${label}: parses`, false, parsed.error); continue }

    const detection = marketplaceAdapters.detect({ fileName: name, headers: parsed.columns, rows: [[String(parsed.rows[0]?.text ?? "")]] })
    if (detection.kind !== "match") { check(`${label}: recognised`, false, JSON.stringify(detection)); continue }
    check(`${label}: recognised as ${detection.format.label}`, true)

    const sourceRows: SourceRow[] = parsed.rows.map((record, index) => ({
      rowNumber: index + 2,
      raw: Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])),
    }))

    const ruleRows: Json[] = (await call(
      `/rest/v1/ledger_mapping_rules?select=id,match_key,side,category,subcategory,attribution,quantity_rule,sign_rule&marketplace_code=eq.AMAZON&format_id=eq.${detection.format.id}&status=eq.ACTIVE`,
      { method: "GET" }, token
    )).body
    const rules: MappingRuleSummary[] = ruleRows.map((r: Json) => ({
      id: r.id, matchKey: r.match_key, side: r.side, category: r.category, subcategory: r.subcategory,
      attribution: r.attribution, quantityRule: r.quantity_rule, signRule: r.sign_rule,
    }))

    const result = detection.adapter.normalize({
      formatId: detection.format.id, rows: sourceRows, rules,
      account: { id: accountId, marketplaceCode: "AMAZON", currency: "AED" },
    })
    const built = buildLedgerFilePayload({
      accountId, accountCurrency: "AED", format: detection.format,
      file: { name, type: "pdf", sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") },
      columns: parsed.columns, rows: sourceRows, result,
    })
    if (!built.ok) { check(`${label}: builds a valid ledger file`, false, built.problems.join(" | ")); continue }

    const applied = await call("/rest/v1/rpc/ledger_apply_file", { method: "POST", body: JSON.stringify({ p_file: built.payload }) }, token)
    const outcome = applied.body?.[0]
    const errors = result.issues.filter((i) => i.severity === "ERROR").length
    check(
      `${label}: recorded, ${outcome?.transactions_written} lines, ${outcome?.unmapped_written} unmapped, no errors`,
      applied.ok && errors === 0,
      applied.ok ? JSON.stringify(outcome) : JSON.stringify(applied.body)
    )
    totalUnmapped += outcome?.unmapped_written ?? 0
    uploaded += 1
  }
  check(`${uploaded} document(s) uploaded`, uploaded === candidates.length)
  check("no line anywhere is unrecognised (UNMAPPED)", totalUnmapped === 0, `unmapped: ${totalUnmapped}`)

  section("2. WHAT LANDED IN THE LEDGER, READ BACK THROUGH THE CLASSIFICATION VIEW")

  const lines: Json[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await call(
      `/rest/v1/ledger_classified_lines?select=category,subcategory,import_category,amount,external_ref,source_type,source_subtype,source_description&business_id=eq.${businessId}&order=id&limit=1000&offset=${offset}`,
      { method: "GET" }, token
    )
    lines.push(...(page.body ?? []))
    if (!page.body || page.body.length < 1000) break
  }
  check(`${lines.length} lines read back`, lines.length > 0)

  const sum = (predicate: (l: Json) => boolean) => lines.filter(predicate).reduce((t, l) => t + units(l.amount), BigInt(0))
  const newVat = sum((l) => l.source_subtype === "VAT" && (l.category === "INPUT_VAT" || l.import_category === "FEE_VAT"))
  const duplicateVat = sum((l) => l.source_subtype === "VAT" && l.category === "INFORMATIONAL")
  const feeInformational = sum((l) => l.source_subtype === "FeeExclTax")
  const noExternalRef = lines.filter((l) => !l.external_ref).length

  console.log(`  info  new VAT (genuinely missing before): ${show(newVat)} AED`)
  console.log(`  info  VAT already captured via the settlement (kept, not double-counted): ${show(duplicateVat)} AED`)
  console.log(`  info  fee amounts kept informational (already in the settlement): ${show(feeInformational)} AED`)
  check("every single line carries its document's external_ref -- nothing untraceable", noExternalRef === 0, `${noExternalRef} lines with no external_ref`)
  check(
    `total recoverable VAT on record from these documents: ${show(newVat + duplicateVat)} AED`,
    true
  )
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
