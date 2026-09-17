/**
 * Expected payouts and cashflow, offline (GCC Phase 8, part 1).
 *
 * Run with:  npm run test:payouts   (part of npm run verify)
 *
 * Proves, without a database, the owner's rule: an amount from a marketplace
 * report is an EXPECTED payout, never money received, and the bank side stays
 * NOT_CONNECTED -- in the migration, the labels and the screen.
 */

import { readFileSync } from "node:fs"

import { NAVIGATION } from "../src/config/navigation"
import {
  BANK_RECEIPT_LABEL,
  BANK_RECEIPT_STATUS_LABEL,
  EXPECTED_PAYOUT_LABEL,
  PAYOUT_STATUS_HELP,
  PAYOUT_STATUS_LABEL,
} from "../src/services/payouts/labels"

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

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")
const MIGRATION = read("supabase/migrations/0039_expected_payouts_cashflow.sql")
const PAGE = read("src/app/(app)/ledger/payouts/page.tsx")
// The function bodies, without the self-check that names what they must not do.
const BODIES = MIGRATION.slice(0, MIGRATION.indexOf("foreach f in array array['expected_payouts', 'expected_cashflow']")).replace(/--.*$/gm, "")
const RECEIVED_WORDS = /\b(received|receipts? confirmed|in your bank|deposited|arrived)\b/i

/* -------------------------------------------------------------------------- */
section("1. THE WORDS")

check("the two concepts have their own names", EXPECTED_PAYOUT_LABEL === "Expected marketplace payout" &&
  BANK_RECEIPT_LABEL === "Actual bank receipt")
check("the bank side reads 'Not connected'", BANK_RECEIPT_STATUS_LABEL.NOT_CONNECTED === "Not connected")
check("every status has a label and an explanation",
  (["ADDS_UP", "DOES_NOT_ADD_UP", "NO_TOTAL", "MARKETPLACE_PAYMENT"] as const).every((s) => PAYOUT_STATUS_LABEL[s] && PAYOUT_STATUS_HELP[s]))
check("no status label claims money was received",
  Object.values(PAYOUT_STATUS_LABEL).every((l) => !RECEIVED_WORDS.test(l)),
  JSON.stringify(PAYOUT_STATUS_LABEL))

/* -------------------------------------------------------------------------- */
section("2. MIGRATION 0039")

check("readers only: no table, no write", !/create table|insert into|update public\.|delete from/i.test(BODIES))
check("no bank data is read or created", !/bank_transactions|bank_accounts/.test(BODIES))
check("the bank side is always NOT_CONNECTED, with no amount or date",
  MIGRATION.includes("'NOT_CONNECTED'::text,\n  null::text,\n  null::timestamptz"))
check("a settlement's expected payout is its reported total", MIGRATION.includes("st.reported_total                                        as expected_amount"))
check("a settlement without a total gets no invented amount", MIGRATION.includes("when st.reported_total is null then 'NO_TOTAL'"))
check("a withdrawn file never counts", (MIGRATION.match(/and b\.withdrawn_at is null/g) ?? []).length === 2)
check("noon's reported payments are included, voided or manual ones are not",
  MIGRATION.includes("po.settlement_id is null") && MIGRATION.includes("po.voided_at is null") &&
    MIGRATION.includes("po.origin = 'SOURCE_FILE'"))
check("cashflow never fills in a bank amount", MIGRATION.includes("'NOT_CONNECTED'::text,\n    null::text\n  from public.expected_payouts"))
check("both readers are invoker and closed to signed-out callers",
  MIGRATION.includes("security invoker") && MIGRATION.includes("revoke all on function %s from anon, public"))

/* -------------------------------------------------------------------------- */
section("3. THE SCREEN")

check("the menu has Payouts and cashflow", NAVIGATION.flatMap((s) => s.items).some((i) => i.href === "/ledger/payouts" && i.enabled))
check("the page shows the bank as not connected, next to every expected amount",
  PAGE.includes("BANK_RECEIPT_STATUS_LABEL.NOT_CONNECTED") && PAGE.includes("BANK_RECEIPT_STATUS_LABEL[p.bank_receipt_status]") &&
    PAGE.includes("BANK_RECEIPT_STATUS_LABEL[c.bank_receipt_status]"))
check("the page says expected amounts are not money received", PAGE.includes("not as money received"))
check("no service-role access, no arithmetic on money",
  !/service[_-]?role/i.test(PAGE) && !/\bNumber\(|parseFloat\(|\.toFixed\(/.test(PAGE))

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
