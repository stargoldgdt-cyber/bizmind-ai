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

import { groupDataSources, groupOf, groupTotals, partOf, type ImportGroup } from "../src/features/imports/groups"
import type { DataSource } from "../src/features/imports/queries"

import type { LedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import {
  LEDGER_PART_ROWS,
  LEDGER_SINGLE_FILE_ROWS,
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
  /splitLedgerFilePayload\(\s*built\.payload/.test(route) && /parts: parts\.length/.test(route) && /applyLedgerFile\(parts\[partIndex\]\)/.test(route))
check("the route still refuses a part that does not exist, and does automatic SKU matching only after the last part",
  /That part of the file does not exist/.test(route) && /last \? await matchIdenticalSkus/.test(route))
check("the screen sends the same file once per part, adds up the parts and says how to carry on after a failure",
  /form\.append\("part"/.test(uploader) && /Upload the same file again to carry on/.test(uploader) && /Recording part/.test(uploader))
check("no money is added up in TypeScript: only counts of rows and lines are summed",
  !/\b(Number|parseFloat|parseInt)\(.*(amount|net_sales|total)/i.test(uploader))

/* ---------------------------------------------------------------------------- */
section("5b. IT DECIDES BY ITSELF: WHOLE WHEN NORMAL, IN PARTS WHEN LARGE")

const whole = file({ rows: LEDGER_SINGLE_FILE_ROWS })
check("a normal file (up to the single-file limit) is recorded whole, as one file, untouched",
  (() => { const out = splitLedgerFilePayload(whole, LEDGER_PART_ROWS, LEDGER_SINGLE_FILE_ROWS); return out.length === 1 && out[0] === whole })())
check("one row over the limit it is split into parts of at most the part size",
  (() => {
    const out = splitLedgerFilePayload(file({ rows: LEDGER_SINGLE_FILE_ROWS + 1 }), LEDGER_PART_ROWS, LEDGER_SINGLE_FILE_ROWS)
    return out.length === 2 && out.every((p) => p.rows.length <= LEDGER_PART_ROWS)
  })())
check("the single-file limit is above the part size and still inside the database's time limit (about 3 ms a row against 8 s)",
  LEDGER_SINGLE_FILE_ROWS > LEDGER_PART_ROWS && LEDGER_SINGLE_FILE_ROWS * 3 <= 5000)
check("a big file splits the same way whatever the single-file limit, so a file already recorded in parts is recognised if sent again",
  JSON.stringify(splitLedgerFilePayload(file({ rows: 4616 }), LEDGER_PART_ROWS, LEDGER_SINGLE_FILE_ROWS).map((p) => p.file_sha256)) ===
    JSON.stringify(splitLedgerFilePayload(file({ rows: 4616 }), LEDGER_PART_ROWS).map((p) => p.file_sha256)))
check("a whole-file attempt that ran out of time is retried in parts: forcing splits a file that would have gone whole",
  (() => {
    const forced = splitLedgerFilePayload(file({ rows: 1200 }), LEDGER_PART_ROWS, LEDGER_SINGLE_FILE_ROWS, true)
    return forced.length === 2 && forced.every((p) => p.rows.length <= LEDGER_PART_ROWS)
  })())

const routeSource = readFileSync("src/app/api/v1/ledger-files/route.ts", "utf8")
const screenSource = readFileSync("src/features/imports/components/settlement-uploader.tsx", "utf8")
check("the route tells the screen to retry in parts only for a whole file that timed out, never for a part or a retry",
  /retryInParts: true/.test(routeSource) && /parts\.length === 1 && fields\.data\.split !== "1" && \/statement timeout\/i/.test(routeSource))
check("the screen retries in parts by itself, only when nothing was written yet, and never loops",
  /body\.retryInParts && !split && recorded === 0/.test(screenSource) && /split = true/.test(screenSource))

/* ---------------------------------------------------------------------------- */
section("6. THE PARTS SHOW AS ONE FILE")

const source = (name: string, at: string, over: Partial<DataSource> = {}): DataSource => ({
  batch_id: `b-${name}-${at}`, business_id: "biz", entity: "orders", status: "COMPLETED", source: null, file_name: name,
  file_type: "csv", created_at: at, committed_at: at, row_count: 800, rows_valid: 800, rows_failed: 0, created_count: 1000,
  updated_count: 0, errors_count: 0, warnings_count: 0, lineage_status: "RECORDED", records_written: 1000, records_withdrawn: 0,
  withdrawn_at: null, withdrawal_reason: null, connection_name: null, matched_count: 0, dataset: "LEDGER", format_id: "noon.tv",
  marketplace_account_id: "acc", marketplace_label: "Noon.sa", marketplace_code: "NOON", transactions_count: 1000,
  settlements_count: 0, payouts_count: 2, unmapped_count: 0, ...over,
} as DataSource)
const six = [1, 2, 3, 4, 5, 6].map((n) => source(`feb.csv (part ${n} of 6)`, `2026-10-06T10:0${n}:00Z`))
const other = source("jan.csv", "2026-10-02T10:00:00Z")
const entries = groupDataSources([other, ...six])

check("six parts of one upload are one entry, and an ordinary file stays as it is",
  entries.length === 2 && entries[0].kind === "group" && entries[1].kind === "single")
const group = entries[0] as ImportGroup
check("the group carries the file's own name, the part count and the parts in order",
  group.name === "feb.csv" && group.of === 6 && group.parts.map((p) => partOf(p.file_name)?.part).join(",") === "1,2,3,4,5,6")
check("its totals add up the parts: rows, lines and records counting",
  groupTotals(group).rows === 4800 && groupTotals(group).lines === 6000 && groupTotals(group).counting === 6000 && groupTotals(group).complete)
check("an upload that stopped part-way is a group that says it is not complete",
  groupTotals(groupDataSources(six.slice(0, 3))[0] as ImportGroup).complete === false)
check("the same file uploaded again another day is a new file, not more parts of the old one",
  groupDataSources([...six, ...[1, 2, 3, 4, 5, 6].map((n) => source(`feb.csv (part ${n} of 6)`, `2026-10-09T10:0${n}:00Z`))]).length === 2)
check("parts of different accounts are never grouped",
  groupDataSources([
    source("x.csv (part 1 of 2)", "2026-10-06T10:00:00Z"),
    source("x.csv (part 2 of 2)", "2026-10-06T10:01:00Z", { marketplace_account_id: "other" }),
  ]).length === 2)
check("withdrawn parts show: all withdrawn is withdrawn, some is partly",
  groupTotals(groupDataSources(six.map((p) => ({ ...p, withdrawn_at: "2026-10-07T00:00:00Z" })))[0] as ImportGroup).withdrawn === 6 &&
    groupTotals(groupDataSources(six.map((p, i) => (i < 2 ? { ...p, withdrawn_at: "2026-10-07T00:00:00Z" } : p)))[0] as ImportGroup).withdrawn === 2)
check("the file a part belongs to can be found from any of its parts",
  groupOf([other, ...six], six[3].batch_id)?.parts.length === 6 && groupOf([other, ...six], other.batch_id) === null)
check("only a real part name counts: odd names are left alone",
  partOf("feb (part 0 of 6).csv") === null && partOf("feb.csv (part 7 of 6)") === null && partOf("feb.csv (part 1 of 1)") === null && partOf("feb.csv") === null)
const ledgerActions = readFileSync("src/features/imports/ledger-actions.ts", "utf8")
check("the whole file is withdrawn and put back together, one withdrawal per part, stopping at the first failure",
  /withdrawLedgerFilesAction/.test(ledgerActions) && /restoreLedgerFilesAction/.test(ledgerActions) &&
    /parts were withdrawn first; run it again to finish/.test(ledgerActions))

console.log(`\n${"=".repeat(74)}\n RESULT: ${passed} passed, ${failed} failed\n${"=".repeat(74)}`)
process.exit(failed === 0 ? 0 : 1)
