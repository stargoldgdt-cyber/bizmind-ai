/**
 * Acceptance: the owner's REAL Amazon settlements reproduce their July figures.
 *
 * Run with:  npm run test:amazon-acceptance -- "C:/path/one.txt" "C:/path/two.txt" ...
 *
 * Only the files named on the command line are read -- never a whole folder,
 * which may hold other private reports. The owner's four June-August 2026
 * Amazon.ae settlements are expected. They are read from where they are and
 * NEVER copied into the repository; no settlement id or buyer detail is
 * written here.
 *
 * What it does, in a throwaway business that is deleted at the end:
 *   1. uploads each file through the real parser, adapter, builder and rules
 *   2. checks every settlement reconciles to Amazon's own total
 *   3. reads back the July 2026 ledger lines and adds them up
 *   4. compares them with the figures the owner measured for July
 *
 * The additions happen HERE, in a test, in exact integer units of 0.0001, to
 * prove the ledger holds the right lines. The product's own P&L arithmetic is
 * SQL, in Phase 3.
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

if (candidates.length === 0) {
  console.log("\n  SKIPPED  The real settlement files were not found.")
  console.log('  Run:  npm run test:amazon-acceptance -- "C:/path/one.txt" "C:/path/two.txt" ...\n')
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
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  return (await response.json()).access_token
}

/** Exact decimal text (up to 4 places) as an integer count of 0.0001. */
function units(value: string): bigint {
  const negative = value.startsWith("-")
  const [whole, fraction = ""] = value.replace("-", "").split(".")
  const scaled = BigInt(whole + fraction.padEnd(4, "0").slice(0, 4))
  return negative ? -scaled : scaled
}

function show(value: bigint): string {
  const negative = value < BigInt(0)
  const digits = (negative ? -value : value).toString().padStart(5, "0")
  const text = `${digits.slice(0, -4)}.${digits.slice(-4, -2)}`
  return negative ? `-${text}` : text
}

const token = await signIn()
const suffix = Date.now().toString(36)
const business = await call("/rest/v1/rpc/create_business", {
  method: "POST",
  body: JSON.stringify({ p_name: `Amazon Acceptance ${suffix}`, p_slug: `amazon-acceptance-${suffix}`, p_currency: "AED" }),
}, token)
const businessId: string = business.body.id

try {
  const account = await call("/rest/v1/rpc/marketplace_account_create", {
    method: "POST",
    body: JSON.stringify({ p_business_id: businessId, p_marketplace_code: "AMAZON", p_label: "Amazon.ae", p_country: "AE", p_currency: "AED" }),
  }, token)
  const accountId: string = account.body

  const ruleRows: Json[] = (await call(
    "/rest/v1/ledger_mapping_rules?select=id,match_key,side,category,subcategory,attribution,quantity_rule,sign_rule&marketplace_code=eq.AMAZON&format_id=eq.amazon.settlement.flat_file_v2&status=eq.ACTIVE",
    { method: "GET" }, token
  )).body
  const rules: MappingRuleSummary[] = ruleRows.map((r) => ({
    id: r.id, matchKey: r.match_key, side: r.side, category: r.category, subcategory: r.subcategory,
    attribution: r.attribution, quantityRule: r.quantity_rule, signRule: r.sign_rule,
  }))

  /* ------------------------------------------------------------------------ */
  section("1. EACH REAL SETTLEMENT GOES THROUGH THE UPLOAD PATH")

  let settlementFiles = 0
  for (const path of candidates) {
    const name = basename(path)
    const label = `settlement file ${settlementFiles + 1}`
    const buffer = readFileSync(path)
    const parsed = await parseFile(buffer, name)
    if ("error" in parsed) throw new Error(`${label}: ${parsed.error}`)
    const detection = marketplaceAdapters.detect({ fileName: name, headers: parsed.columns, rows: [] })
    if (detection.kind !== "match") throw new Error(`${label}: not an Amazon Flat File V2 settlement (${detection.kind})`)
    settlementFiles += 1

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
    if (!built.ok) throw new Error(`${label}: ${built.problems.join(" | ")}`)

    const applied = await call("/rest/v1/rpc/ledger_apply_file", { method: "POST", body: JSON.stringify({ p_file: built.payload }) }, token)
    const outcome = applied.body?.[0]
    const errors = result.issues.filter((i) => i.severity === "ERROR").length
    check(
      `${label}: recorded, ${outcome?.transactions_written} lines, no unreadable rows, no unrecognised codes`,
      applied.ok && errors === 0 && outcome?.unmapped_written === 0 && result.settlements.length === 1,
      applied.ok ? `errors ${errors}, unmapped ${outcome?.unmapped_written}` : JSON.stringify(applied.body)
    )

    const settlement = (await call("/rest/v1/rpc/ledger_file_settlements", { method: "POST", body: JSON.stringify({ p_source_file_id: outcome.source_file_id }) }, token)).body?.[0]
    check(
      `${label}: its lines add up exactly to Amazon's total (${settlement?.reported_total})`,
      settlement?.reconciles === true && settlement?.payout_amount === settlement?.reported_total,
      JSON.stringify(settlement)
    )
  }

  check("the four owner settlements were given", settlementFiles === 4, `given ${settlementFiles}`)

  /* ------------------------------------------------------------------------ */
  section("2. JULY 2026, FROM THE LEDGER")

  const july: Json[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await call(
      `/rest/v1/ledger_lines?select=side,category,subcategory,amount,quantity,quantity_basis&business_id=eq.${businessId}` +
        `&posted_at=gte.2026-07-01T00:00:00Z&posted_at=lt.2026-08-01T00:00:00Z&order=id&limit=1000&offset=${offset}`,
      { method: "GET" }, token
    )
    july.push(...(page.body ?? []))
    if (!page.body || page.body.length < 1000) break
  }
  check("1,154 July lines, the same count the raw files give by posted date", july.length === 1154, String(july.length))

  const sum = (predicate: (line: Json) => boolean) =>
    july.filter(predicate).reduce((total, line) => total + units(line.amount), BigInt(0))
  const is = (side: string | null, category: string, subcategory?: string) => (line: Json) =>
    line.side === side && line.category === category && (subcategory === undefined || line.subcategory === subcategory)

  const gross = sum(is("PNL", "REVENUE"))
  const commission = sum(is("PNL", "MARKETPLACE_FEE", "referral"))
  const fba = sum(is("PNL", "FULFILMENT", "fba_per_unit"))
  const refunds = sum(is("PNL", "REFUND", "principal"))
  const adsPremium = sum(is("PNL", "ADVERTISING")) + sum(is("PNL", "MARKETPLACE_FEE", "premium_services")) + sum(is("TAX", "FEE_VAT", "premium_services"))
  const contribution = sum((line) => line.side === "PNL" || line.side === "TAX")
  const beforeFeeVat = sum((line) => line.side === "PNL")
  const unitsSold = july.filter(is("PNL", "REVENUE", "principal")).reduce((t, l) => t + units(l.quantity ?? "0"), BigInt(0)) / BigInt(10000)
  const unitsRefunded = july.filter((l) => l.quantity_basis === "DERIVED_LINE_COUNT").length

  const figures: [string, bigint, string, string][] = [
    ["Gross (Principal + Shipping)", gross, "61429.11", "61,429"],
    ["Commission, net of refund reversals", commission, "-4327.27", "-4,327"],
    ["FBA fulfilment", fba, "-7112.92", "-7,113"],
    ["Refund value", refunds, "-5207.13", "-5,207"],
    ["Ads + SP 360 fee + its VAT", adsPremium, "-7780.18", "-7,780"],
    ["Contribution including fee VAT", contribution, "36432.97", "36,433"],
  ]
  for (const [label, value, exact, owners] of figures) {
    check(`${label}: ${show(value)} (owner measured ${owners})`, show(value) === exact, `expected ${exact}`)
  }
  console.log(`  info  Contribution before VAT on fees (decision B1 decides which counts): ${show(beforeFeeVat)}`)
  check(`Units sold: ${unitsSold} (owner measured 296)`, unitsSold === BigInt(296))
  check(`Units refunded: ${unitsRefunded} (owner measured 25)`, unitsRefunded === 25)
  check("No July line is unrecognised", !july.some((line) => line.category === "UNMAPPED"))

  /* ------------------------------------------------------------------------ */
  section("3. JULY 2026, FROM THE P&L ENGINE (migration 0032)")

  const period = { p_from: "2026-07-01T00:00:00Z", p_to: "2026-08-01T00:00:00Z", p_account_id: accountId }
  const summaryNow = async () =>
    (await call("/rest/v1/rpc/pnl_summary", { method: "POST", body: JSON.stringify(period) }, token)).body?.[0]
  const setVat = (treatment: string) =>
    call("/rest/v1/rpc/tax_profile_set_input_vat", {
      method: "POST", body: JSON.stringify({ p_account_id: accountId, p_treatment: treatment }),
    }, token)

  const unknownVat = await summaryNow()
  check("Gross sales 61429.1100", unknownVat?.gross_sales === "61429.1100", JSON.stringify(unknownVat))
  check("Net sales 55905.2100 (refunds -5242.13, shipping promotions -281.77)", unknownVat?.net_sales === "55905.2100")
  check("Marketplace fees -6908.8400", unknownVat?.marketplace_fees === "-6908.8400")
  check("Fulfillment -7278.9200", unknownVat?.fulfillment === "-7278.9200")
  check("Advertising -5264.6900", unknownVat?.advertising === "-5264.6900")
  check("Other income 100.0000 (COD charges)", unknownVat?.other_income === "100.0000")
  check("Every July line classified automatically", unknownVat?.unknown_lines === 0 && unknownVat?.review_lines === 0)
  check(
    "VAT setting Unknown: no final contribution; AED 119.79 unresolved; informational 36552.7600",
    unknownVat?.contribution === null && unknownVat?.contribution_status === "INCOMPLETE" &&
      unknownVat?.input_vat_unresolved === "-119.7900" && unknownVat?.contribution_before_open_items === "36552.7600"
  )

  await setVat("RECOVERABLE")
  const recoverable = await summaryNow()
  check(
    "Recoverable: final contribution 36552.7600",
    recoverable?.contribution === "36552.7600" && recoverable?.contribution_status === "FINAL",
    JSON.stringify(recoverable)
  )

  await setVat("NON_RECOVERABLE")
  const nonRecoverable = await summaryNow()
  check(
    "Non-recoverable: final contribution 36432.9700",
    nonRecoverable?.contribution === "36432.9700" && nonRecoverable?.non_recoverable_vat === "-119.7900",
    JSON.stringify(nonRecoverable)
  )

  /* ------------------------------------------------------------------------ */
  section("4. JULY 2026 BY PRODUCT (migration 0035)")

  check(
    "No products yet: 296 units sold, gross profit incomplete because SKUs are not matched",
    nonRecoverable?.units_sold === "296.0000" && nonRecoverable?.gross_profit === null &&
      JSON.stringify(nonRecoverable?.gross_profit_reasons) === JSON.stringify(["SKU_NOT_MAPPED"]),
    JSON.stringify(nonRecoverable)
  )
  const productRows: Json[] = (await call("/rest/v1/rpc/pnl_by_product", {
    method: "POST", body: JSON.stringify(period),
  }, token)).body ?? []
  const productTotal = productRows.reduce((total, row) => total + units(row.contribution), BigInt(0))
  check(
    `The ${productRows.length} product rows add up to the account's contribution (36432.97)`,
    show(productTotal) === "36432.97",
    show(productTotal)
  )
  check(
    "Only SKU rows and one row not allocated to a product; no product rows yet",
    productRows.filter((row) => row.row_kind === "NOT_ALLOCATED").length === 1 &&
      productRows.every((row) => row.row_kind !== "PRODUCT")
  )

  const monthsOffered: Json[] = (await call("/rest/v1/rpc/pnl_periods", {
    method: "POST", body: JSON.stringify({ p_business_id: businessId }),
  }, token)).body ?? []
  check(
    "The dashboard offers July 2026 with its 1,154 lines",
    monthsOffered.some((m) => m.month === "2026-07-01" && m.lines === 1154),
    JSON.stringify(monthsOffered)
  )

  const julySettlements: Json[] = (await call("/rest/v1/rpc/pnl_settlements", {
    method: "POST", body: JSON.stringify(period),
  }, token)).body ?? []
  const julyLineCount = julySettlements.reduce((total, s) => total + s.lines_in_period_count, 0)
  check(
    `July touches ${julySettlements.length} settlement(s); each adds up to Amazon's total and its payout`,
    julySettlements.length > 0 &&
      julySettlements.every((s) => s.reconciles === true && s.payout_amount === s.reported_total),
    JSON.stringify(julySettlements)
  )
  check("Their July lines are the same 1,154", julyLineCount === 1154, String(julyLineCount))
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
