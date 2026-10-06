/**
 * Splitting a large settlement file into parts the database can record in time
 * (src/services/marketplaces/ledger-file-parts.ts).
 *
 * Offline: pure functions only. The live behaviour (a 10,500-row noon file
 * recorded in 11 parts, nothing lost or doubled, repeating it skipped) was
 * checked against the real database on 2026-10-06; see DECISIONS.md.
 *
 *   npm run test:ledger-parts
 */
import { readFileSync } from "node:fs"

import type { LedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import {
  LEDGER_PART_ROWS,
  MAX_LEDGER_PARTS,
  partFingerprint,
  splitLedgerFilePayload,
} from "../src/services/marketplaces/ledger-file-parts"

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

const SHA = "a".repeat(64)

type Overrides = {
  rows?: number
  payoutEvery?: number
  duplicatePairs?: [number, number][]
  oneSettlement?: boolean
}

/** A noon-shaped file: each row has its own order, two ledger lines, and now and then a payout. */
function file({ rows = 10, payoutEvery = 0, duplicatePairs = [], oneSettlement = false }: Overrides = {}): LedgerFilePayload {
  const duplicateOf = new Map(duplicatePairs.map(([from, to]) => [to, from]))
  const payload: LedgerFilePayload = {
    marketplace_account_id: "00000000-0000-4000-8000-000000000001",
    format_id: "noon.transaction_view",
    adapter_version: "1",
    source_kind: "UPLOAD",
    file_name: "noon-feb.csv",
    file_type: "csv",
    file_size_bytes: rows * 100,
    file_sha256: SHA,
    columns: ["Order Nr", "Total"],
    stripped_columns: [],
    rows: [],
    settlements: [],
    payouts: [],
    transactions: [],
    issues: [],
  }
  if (oneSettlement) {
    payload.settlements.push({
      external_settlement_id: "S1", source_row_number: 2, period_start: null, period_end: null,
      reported_total: null, reported_deposit_date: null, currency: "AED",
    })
  }
  for (let i = 0; i < rows; i++) {
    const rowNumber = i + 2
    const source = duplicateOf.get(i)
    payload.rows.push({ row_number: rowNumber, raw: { "Order Nr": `O${source ?? i}`, Total: "10" } })
    const payoutKey = payoutEvery > 0 && i % payoutEvery === 0 ? `P${i}` : null
    if (payoutKey) {
      payload.payouts.push({
        key: payoutKey, source_row_number: rowNumber, external_ref: null, amount: "-5", currency: "AED", paid_at: null, settlement_ref: null,
      })
    }
    for (const line of [0, 1]) {
      payload.transactions.push({
        source_row_number: rowNumber, line_index: line, mapping_rule_id: null, side: null, category: "UNMAPPED", subcategory: null,
        source_type: "order", source_subtype: null, source_description: null, amount: "5", currency: "AED",
        posted_at: "2026-02-01T00:00:00Z", order_ref: `O${i}`, order_line_ref: null, raw_sku: null, quantity: null,
        quantity_basis: null, attribution: "ORDER", settlement_ref: oneSettlement ? "S1" : null, payout_ref: payoutKey, external_ref: null,
      })
    }
  }
  return payload
}

/* ---------------------------------------------------------------------------- */
section("1. WHEN IT SPLITS, AND WHEN IT DOES NOT")

check("a file within one part is returned untouched, as the same object", (() => {
  const small = file({ rows: LEDGER_PART_ROWS })
  const parts = splitLedgerFilePayload(small)
  return parts.length === 1 && parts[0] === small
})())
check("the part size is small enough for the database's time limit: about 3 ms a row against an 8 s limit", LEDGER_PART_ROWS <= 1000)
check("a file one row over the limit becomes two parts", splitLedgerFilePayload(file({ rows: LEDGER_PART_ROWS + 1 })).length === 2)

const big = file({ rows: 4500, payoutEvery: 7 })
const parts = splitLedgerFilePayload(big)

/* ---------------------------------------------------------------------------- */
section("2. NOTHING IS LOST OR COUNTED TWICE")

const allRows = parts.flatMap((p) => p.rows.map((r) => r.row_number))
check("every source row is in exactly one part",
  allRows.length === big.rows.length && new Set(allRows).size === big.rows.length)
check("every ledger line is in exactly one part, with its own row",
  parts.flatMap((p) => p.transactions).length === big.transactions.length &&
    parts.every((p) => p.transactions.every((t) => p.rows.some((r) => r.row_number === t.source_row_number))))
check("every payout is in exactly one part, with its own row",
  parts.flatMap((p) => p.payouts).length === big.payouts.length &&
    parts.every((p) => p.payouts.every((x) => p.rows.some((r) => r.row_number === x.source_row_number))))
check("no part is over the limit", parts.every((p) => p.rows.length <= LEDGER_PART_ROWS), parts.map((p) => p.rows.length).join(","))
check("rows keep their file order and their own numbers", allRows.every((n, i) => i === 0 || n > allRows[i - 1]))
check("what a part records is unchanged: amounts and references pass through as given",
  parts.flatMap((p) => p.transactions).every((t) => t.amount === "5" && t.currency === "AED"))
check("the figures add up across the parts: the same number of ledger lines in total",
  parts.reduce((sum, p) => sum + p.transactions.length, 0) === big.transactions.length)

/* ---------------------------------------------------------------------------- */
section("3. WHAT STAYS TOGETHER")

const linked = file({ rows: 30 })
// A ledger line that names a payout held in a far-away row ties the two together.
linked.payouts.push({ key: "FAR", source_row_number: 31, external_ref: null, amount: "-1", currency: "AED", paid_at: null, settlement_ref: null })
linked.transactions[0].payout_ref = "FAR"
const linkedParts = splitLedgerFilePayload(linked, 10)
check("a ledger line and the payout it names are never separated",
  linkedParts.every((p) => p.transactions.every((t) => !t.payout_ref || p.payouts.some((x) => x.key === t.payout_ref))))
const sameRow = linkedParts.find((p) => p.rows.some((r) => r.row_number === 2))
check("...so the first and last rows share a part", Boolean(sameRow?.rows.some((r) => r.row_number === 31)))

const twins = splitLedgerFilePayload(file({ rows: 30, duplicatePairs: [[0, 25]] }), 10)
check("identical rows are never separated (the database would refuse the second as an overlap with the first)",
  twins.some((p) => p.rows.some((r) => r.row_number === 2) && p.rows.some((r) => r.row_number === 27)))

const settled = splitLedgerFilePayload(file({ rows: 3000, oneSettlement: true }))
check("a file tied to one settlement from every row stays one part, exactly as before", settled.length === 1)

/* ---------------------------------------------------------------------------- */
section("4. A FAILED UPLOAD CAN BE REPEATED")

const again = splitLedgerFilePayload(file({ rows: 4500, payoutEvery: 7 }))
check("the same file splits the same way every time",
  JSON.stringify(again.map((p) => [p.file_sha256, p.rows.map((r) => r.row_number).join(",")])) ===
    JSON.stringify(parts.map((p) => [p.file_sha256, p.rows.map((r) => r.row_number).join(",")])))
check("every part has its own fingerprint, different from the file's and from every other part",
  new Set(parts.map((p) => p.file_sha256)).size === parts.length && parts.every((p) => p.file_sha256 !== SHA && /^[0-9a-f]{64}$/.test(p.file_sha256)))
check("a part's fingerprint depends on the file, its place and the number of parts",
  partFingerprint(SHA, 0, 5) !== partFingerprint(SHA, 1, 5) && partFingerprint(SHA, 0, 5) !== partFingerprint(SHA, 0, 6) &&
    partFingerprint(SHA, 0, 5) !== partFingerprint("b".repeat(64), 0, 5))
check("parts are named so the owner can tell them apart, within the 255-character limit",
  parts[0].file_name === `noon-feb.csv (part 1 of ${parts.length})` &&
    splitLedgerFilePayload({ ...big, file_name: "x".repeat(255) }).every((p) => p.file_name.length <= 255))
check("the file type, account and format carry over to every part",
  parts.every((p) => p.marketplace_account_id === big.marketplace_account_id && p.format_id === big.format_id && p.file_type === "csv"))
check("a file that would need too many parts is refused with a plain message",
  (() => {
    try {
      splitLedgerFilePayload(file({ rows: 2000 }), 20)
      return MAX_LEDGER_PARTS >= 100
    } catch (error) {
      return /split it by period/i.test((error as Error).message)
    }
  })())

/* ---------------------------------------------------------------------------- */
section("5. THE ROUTE AND THE SCREEN USE IT")

const route = readFileSync("src/app/api/v1/ledger-files/route.ts", "utf8")
const uploader = readFileSync("src/features/imports/components/settlement-uploader.tsx", "utf8")
check("the route records one part per request and tells the client how many parts there are",
  /splitLedgerFilePayload\(built\.payload\)/.test(route) && /parts: parts\.length/.test(route) && /applyLedgerFile\(parts\[partIndex\]\)/.test(route))
check("the route still refuses a part that does not exist, and does automatic SKU matching only after the last part",
  /That part of the file does not exist/.test(route) && /last \? await matchIdenticalSkus/.test(route))
check("the screen sends the same file once per part, adds up the parts and says how to carry on after a failure",
  /form\.append\("part"/.test(uploader) && /Upload the same file again to carry on/.test(uploader) && /Recording part/.test(uploader))
check("no money is added up in TypeScript: only counts of rows and lines are summed",
  !/\b(Number|parseFloat|parseInt)\(.*(amount|net_sales|total)/i.test(uploader))

console.log(`\n${"=".repeat(74)}\n RESULT: ${passed} passed, ${failed} failed\n${"=".repeat(74)}`)
process.exit(failed === 0 ? 0 : 1)
