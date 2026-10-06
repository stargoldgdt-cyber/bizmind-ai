/**
 * The marketplace adapter contract, the customer-data filter, the ledger file
 * builder and the dataset boundary -- Phase 1, no database, no network.
 *
 * Run with:  npm run test:marketplaces
 *
 * The live half (the database really refusing what these refuse) is
 * `npm run test:ledger`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import {
  DATASET_KEYS,
  DATASET_PLAN,
  createDatasetRegistry,
  datasetTargets,
} from "../src/services/datasets/contract"
import {
  LEDGER_CATEGORIES,
  UNMAPPED,
  type FormatDescriptor,
  type MarketplaceAdapter,
  type NormalizeResult,
  type TransactionDraft,
} from "../src/services/marketplaces/contract"
import {
  CUSTOMER_COLUMN_PATTERN,
  EMAIL_PATTERN,
  containsEmailAddress,
  filterSourceRow,
  isCustomerDataColumn,
} from "../src/services/marketplaces/customer-data"
import {
  EXACT_DECIMAL_PATTERN,
  INSTANT_PATTERN,
  buildLedgerFilePayload,
  type LedgerFileInput,
} from "../src/services/marketplaces/ledger-file"
import { marketplaceAdapters } from "../src/services/marketplaces/adapters"
import { createAdapterRegistry } from "../src/services/marketplaces/registry"

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

function throws(fn: () => unknown, fragment: string): boolean {
  try {
    fn()
    return false
  } catch (error) {
    return (error as Error).message.includes(fragment)
  }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const migration = readFileSync("supabase/migrations/0030_marketplace_ledger_foundation.sql", "utf8")

/* -------------------------------------------------------------------------- */
section("1. ONLY THE ADAPTERS THAT ARE APPROVED ARE REGISTERED")

check(
  "the application registers exactly the approved adapters: Amazon (Phase 2) and noon (Phase 5)",
  marketplaceAdapters.list().map((a) => a.marketplace).join(",") === "AMAZON,NOON"
)
check(
  "noon reads its two report formats",
  (marketplaceAdapters.get("NOON")?.formats.map((f) => f.id).sort().join(",") ?? "") ===
    "noon.invoices_credit_notes,noon.transaction_view.item_level"
)
check("Carrefour has no adapter -- a contract only (A15)", marketplaceAdapters.get("CARREFOUR") === null)
check(
  "only adapters.ts registers an adapter",
  walk("src")
    .filter((file) => readFileSync(file, "utf8").includes("marketplaceAdapters.register("))
    .map((file) => file.replace(/\\/g, "/"))
    .join(",") === "src/services/marketplaces/adapters.ts"
)
check(
  "src/services/marketplaces holds the contract, filter, builder, registry, door and the Amazon and noon adapters",
  JSON.stringify(readdirSync("src/services/marketplaces").sort()) ===
    JSON.stringify(["adapters.ts", "amazon", "apply.ts", "contract.ts", "customer-data.ts", "index.ts", "ledger-file-parts.ts", "ledger-file.ts", "noon", "registry.ts"]),
  readdirSync("src/services/marketplaces").join(", ")
)

/* -------------------------------------------------------------------------- */
section("2. THE REGISTRY REFUSES WHAT WOULD LET A BAD FORMAT IN")

const fixtureFormat: FormatDescriptor = {
  id: "fixture.settlement.v1",
  label: "Fixture settlement",
  adapterVersion: "1.0.0",
  requiredHeaders: ["settlement-id", "amount"],
  allowedColumns: ["settlement-id", "amount", "sku", "posted", "description"],
}

const emptyResult: NormalizeResult = { transactions: [], settlements: [], payouts: [], issues: [] }

function adapter(
  marketplace: string,
  formats: FormatDescriptor[],
  detect: MarketplaceAdapter["detect"] = () => ({ kind: "unknown" })
): MarketplaceAdapter {
  return { marketplace, formats, detect, normalize: () => emptyResult }
}

{
  const registry = createAdapterRegistry()
  registry.register(adapter("FIXTURE", [fixtureFormat]))
  check("a well-formed adapter registers", registry.get("FIXTURE") !== null)
  check(
    "a second adapter for the same marketplace is refused",
    throws(() => registry.register(adapter("FIXTURE", [])), "already registered")
  )
  check(
    "a format id used twice is refused",
    throws(() => registry.register(adapter("OTHER", [fixtureFormat])), "already registered")
  )
  check(
    "A FORMAT THAT ALLOWS A CUSTOMER-DATA COLUMN IS REFUSED",
    throws(
      () =>
        registry.register(
          adapter("PII", [{ ...fixtureFormat, id: "pii.v1", allowedColumns: ["amount", "buyer-email"] }])
        ),
      "customer-data"
    )
  )
  check(
    "a format that requires a header it does not allow is refused",
    throws(
      () =>
        registry.register(
          adapter("GAP", [{ ...fixtureFormat, id: "gap.v1", requiredHeaders: ["amount", "total"], allowedColumns: ["amount"] }])
        ),
      "does not allow"
    )
  )
  check(
    "a marketplace code that is not a code is refused",
    throws(() => registry.register(adapter("amazon", [])), "not a marketplace code")
  )
}

{
  const sample = { fileName: "x.txt", headers: ["settlement-id", "amount"], rows: [] }

  const none = createAdapterRegistry()
  none.register(adapter("FIXTURE", [fixtureFormat]))
  check("a file no adapter recognises is unknown, not guessed", none.detect(sample).kind === "unknown")

  const rejecting = createAdapterRegistry()
  rejecting.register(
    adapter("FIXTURE", [fixtureFormat], () => ({
      kind: "reject",
      formatId: "fixture.summary",
      message: "Download the detailed report instead.",
    }))
  )
  const rejected = rejecting.detect(sample)
  check(
    "a known-bad format is refused with what to download instead",
    rejected.kind === "reject" && rejected.message.includes("Download")
  )

  const two = createAdapterRegistry()
  two.register(adapter("FIRST", [{ ...fixtureFormat, id: "a.v1" }], () => ({ kind: "match", formatId: "a.v1", confidence: "exact" })))
  two.register(adapter("SECOND", [{ ...fixtureFormat, id: "b.v1" }], () => ({ kind: "match", formatId: "b.v1", confidence: "likely" })))
  const ambiguous = two.detect(sample)
  check(
    "TWO FORMATS CLAIMING ONE FILE IS AMBIGUOUS, never a choice made silently",
    ambiguous.kind === "ambiguous" && ambiguous.formatIds.length === 2
  )

  const liar = createAdapterRegistry()
  liar.register(adapter("LIAR", [fixtureFormat], () => ({ kind: "match", formatId: "undeclared", confidence: "exact" })))
  check("an adapter detecting a format it never declared is a bug, not a match", throws(() => liar.detect(sample), "does not declare"))

  const one = createAdapterRegistry()
  one.register(adapter("FIXTURE", [fixtureFormat], () => ({ kind: "match", formatId: fixtureFormat.id, confidence: "exact" })))
  const matched = one.detect(sample)
  check("a single match returns its adapter and format", matched.kind === "match" && matched.format.id === fixtureFormat.id)
}

/* -------------------------------------------------------------------------- */
section("3. CUSTOMER DATA NEVER PASSES THE BOUNDARY")

const customerColumns = [
  "buyer-email", "Buyer Name", "customer_name", "Customer Phone", "ship-to-address",
  "bill_to_city", "Recipient", "Mobile", "Postcode", "Zip Code", "First Name",
  "last_name", "Full Name", "Contact Number", "email", "E-mail", "street", "WhatsApp",
]
const businessColumns = [
  "sku", "settlement-id", "order-id", "merchant-order-id", "amount-description",
  "posted-date-time", "shipment-id", "fulfillment-id", "marketplace-name", "promotion-id",
  "quantity-purchased", "Product Name", "Partner SKUs", "Order Nr", "Transaction Type",
  "deposit-date", "total-amount",
]

const missed = customerColumns.filter((column) => !isCustomerDataColumn(column))
check("every customer-data column is recognised", missed.length === 0, missed.join(", "))
const overreach = businessColumns.filter(isCustomerDataColumn)
check(
  "and no business column is mistaken for one (Amazon V2 headers included)",
  overreach.length === 0,
  overreach.join(", ")
)

check("an email address inside text is found", containsEmailAddress("Refund issued to Ali.Hassan@example.co.ae"))
check(
  "order numbers and references are not mistaken for emails",
  !containsEmailAddress("403-1234567-1234567") && !containsEmailAddress("N12345@") && !containsEmailAddress("fee@5%")
)

{
  const { kept, stripped } = filterSourceRow(
    {
      "settlement-id": "S1",
      amount: "0012.50",
      sku: "   ",
      posted: "",
      notes: "not in the format",
      "buyer-email": "a@b.com",
    },
    [...fixtureFormat.allowedColumns, "buyer-email"]
  )
  check("columns outside the format are stripped", stripped.includes("notes") && !("notes" in kept))
  check(
    "A CUSTOMER COLUMN IS STRIPPED EVEN IF A FORMAT WRONGLY ALLOWS IT",
    stripped.includes("buyer-email") && !("buyer-email" in kept)
  )
  check("a blank or whitespace cell is unknown (null), never \"\" or zero", kept.sku === null && kept.posted === null)
  check("text is kept exactly as read -- \"0012.50\" stays \"0012.50\"", kept.amount === "0012.50")
  check(
    "a value that is not text is refused rather than converted",
    throws(
      () => filterSourceRow({ amount: 12.5 as unknown as string }, ["amount"]),
      "not text"
    )
  )
}

check(
  "THE COLUMN PATTERN IS IDENTICAL IN THE DATABASE",
  migration.includes(`p_name ~* '${CUSTOMER_COLUMN_PATTERN}'`)
)
check("the email pattern is identical in the database", migration.includes(`~* '${EMAIL_PATTERN}'`))
check("the exact-decimal pattern is identical in the database", migration.includes(`'${EXACT_DECIMAL_PATTERN}'`))
check("the instant pattern is identical in the database", migration.includes(`'${INSTANT_PATTERN}'`))

const allCategories = Object.values(LEDGER_CATEGORIES).flat()
const categoriesMissing = allCategories.filter((category) => !migration.includes(`'${category}'`))
check(
  "every ledger category in the contract is one the database accepts",
  categoriesMissing.length === 0,
  categoriesMissing.join(", ")
)

/* -------------------------------------------------------------------------- */
section("4. THE LEDGER FILE BUILDER CHECKS WHAT THE DATABASE WILL CHECK")

const RULE = "11111111-1111-4111-8111-111111111111"

function transaction(overrides: Partial<TransactionDraft> = {}): TransactionDraft {
  return {
    sourceRowNumber: 2,
    lineIndex: 0,
    mappingRuleId: RULE,
    side: "PNL",
    category: "REVENUE",
    subcategory: "principal",
    sourceType: "Order",
    sourceSubtype: "ItemPrice",
    sourceDescription: "Principal",
    amount: "1200.00",
    currency: "AED",
    postedAt: "2026-09-01T10:00:00Z",
    orderRef: "403-1234567-1234567",
    orderLineRef: null,
    rawSku: "SKU-1",
    quantity: "2",
    quantityBasis: "REPORTED",
    attribution: "ORDER_LINE",
    settlementRef: "S1",
    payoutRef: null,
    externalRef: null,
    ...overrides,
  }
}

function input(overrides: { result?: Partial<NormalizeResult>; rows?: LedgerFileInput["rows"]; sha?: string } = {}): LedgerFileInput {
  return {
    accountId: "22222222-2222-4222-8222-222222222222",
    accountCurrency: "AED",
    format: fixtureFormat,
    file: { name: "settlement.csv", type: "csv", sizeBytes: 512, sha256: overrides.sha ?? "a".repeat(64) },
    columns: ["settlement-id", "amount", "sku", "posted", "buyer-email", "notes"],
    rows: overrides.rows ?? [
      { rowNumber: 1, raw: { "settlement-id": "S1", amount: null, "buyer-email": "ali@example.com", notes: "x" } },
      { rowNumber: 2, raw: { "settlement-id": "S1", amount: "1200.00", sku: "SKU-1", posted: "" } },
      { rowNumber: 3, raw: { "settlement-id": "S1", amount: "-150.50", description: "MysteryFee" } },
    ],
    result: {
      settlements: [
        {
          externalSettlementId: "S1", sourceRowNumber: 1, periodStart: null, periodEnd: null,
          reportedTotal: "1049.50", reportedDepositDate: null, currency: "AED",
        },
      ],
      payouts: [],
      transactions: [
        transaction(),
        transaction({
          sourceRowNumber: 3, mappingRuleId: null, side: null, category: UNMAPPED, subcategory: null,
          amount: "-150.50", quantity: null, quantityBasis: null, rawSku: null, sourceDescription: "MysteryFee",
        }),
      ],
      issues: [],
      ...overrides.result,
    },
  }
}

function problemsOf(value: LedgerFileInput): string {
  const built = buildLedgerFilePayload(value)
  return built.ok ? "" : built.problems.join(" | ")
}

{
  const built = buildLedgerFilePayload(input())
  check("a well-formed file builds", built.ok, built.ok ? "" : built.problems.join(" | "))
  if (built.ok) {
    const { payload } = built
    check(
      "the customer column and the out-of-format column are recorded as stripped, by name",
      payload.stripped_columns.includes("buyer-email") && payload.stripped_columns.includes("notes")
    )
    check(
      "AND NO STRIPPED VALUE REACHES THE PAYLOAD",
      !JSON.stringify(payload.rows).includes("ali@example.com") && !JSON.stringify(payload.rows).includes("buyer-email")
    )
    check("a blank cell reaches the database as null", payload.rows[1].raw.posted === null && payload.rows[0].raw.amount === null)
    check("money stays text", typeof payload.transactions[0].amount === "string" && payload.transactions[0].amount === "1200.00")
    check("a blank settlement total would stay null", payload.settlements[0].reported_deposit_date === null)
  }
}

const cases: [string, LedgerFileInput, string][] = [
  ["more than 4 decimal places is refused", input({ result: { transactions: [transaction({ amount: "12.34567" }), input().result.transactions[1]] } }), "exact decimal"],
  ["a thousands separator is refused, not interpreted", input({ result: { transactions: [transaction({ amount: "1,200.00" }), input().result.transactions[1]] } }), "exact decimal"],
  ["A BLANK AMOUNT IS NOT A TRANSACTION -- it must be a row issue", input({ result: { transactions: [transaction({ amount: "" }), input().result.transactions[1]] } }), "row issue"],
  ["a timestamp without a time zone is refused", input({ result: { transactions: [transaction({ postedAt: "2026-09-01 10:00:00" }), input().result.transactions[1]] } }), "time zone"],
  ["A CURRENCY MISMATCH IS REFUSED", input({ result: { transactions: [transaction({ currency: "SAR" }), input().result.transactions[1]] } }), "does not match the account currency"],
  ["A TRANSACTION WITHOUT A SOURCE ROW HAS NO LINEAGE AND IS REFUSED", input({ result: { transactions: [transaction({ sourceRowNumber: 99 }), input().result.transactions[1]] } }), "no lineage"],
  ["A ROW NOTHING ACCOUNTS FOR IS REFUSED -- nothing is dropped silently", input({ result: { transactions: [transaction()] } }), "Row 3 is not used"],
  ["an email in a transaction description is refused", input({ result: { transactions: [transaction({ sourceDescription: "refund to a@b.com" }), input().result.transactions[1]] } }), "email"],
  [
    "an email inside an allowed column's value is refused",
    input({
      rows: [
        { rowNumber: 1, raw: { "settlement-id": "S1" } },
        { rowNumber: 2, raw: { "settlement-id": "S1", description: "contact me: z@q.io" } },
        { rowNumber: 3, raw: { "settlement-id": "S1" } },
      ],
    }),
    "email",
  ],
  ["an UNMAPPED line cannot carry a mapping rule", input({ result: { transactions: [transaction(), transaction({ sourceRowNumber: 3, category: UNMAPPED, side: null })] } }), "cannot have a mapping rule"],
  ["a line with no rule must be UNMAPPED", input({ result: { transactions: [transaction(), transaction({ sourceRowNumber: 3, mappingRuleId: null })] } }), "must be UNMAPPED"],
  ["a quantity without its basis is refused", input({ result: { transactions: [transaction({ quantityBasis: null }), input().result.transactions[1]] } }), "given together"],
  ["a settlement reference that is not in the file is refused", input({ result: { transactions: [transaction({ settlementRef: "S9" }), input().result.transactions[1]] } }), "not in this file"],
  [
    "a repeated row number is refused",
    input({
      rows: [
        { rowNumber: 1, raw: {} },
        { rowNumber: 1, raw: {} },
        { rowNumber: 2, raw: {} },
        { rowNumber: 3, raw: {} },
      ],
    }),
    "more than once",
  ],
  ["a malformed fingerprint is refused", input({ sha: "ABC" }), "SHA-256"],
]

for (const [name, value, fragment] of cases) {
  const problems = problemsOf(value)
  check(name, problems.includes(fragment), problems || "(no problem reported)")
}

/* -------------------------------------------------------------------------- */
section("5. THE GOOGLE SHEETS DATASET BOUNDARY")

check(
  "the six approved datasets, and only those",
  JSON.stringify([...DATASET_KEYS]) ===
    JSON.stringify(["PRODUCT_MASTER", "COGS", "OPERATING_EXPENSES", "ADVERTISING_EXPENSES", "BANK_TRANSACTIONS", "SKU_ALIAS_SUGGESTIONS"])
)
check(
  "V1 is COGS, product master and operating expenses",
  DATASET_KEYS.filter((key) => DATASET_PLAN[key].tier === "V1").sort().join(",") === "COGS,OPERATING_EXPENSES,PRODUCT_MASTER"
)
check(
  "SKU mapping from a sheet can only ever suggest",
  DATASET_PLAN.SKU_ALIAS_SUGGESTIONS.suggestionsOnly &&
    DATASET_KEYS.filter((key) => DATASET_PLAN[key].suggestionsOnly).length === 1
)
check("no dataset target is registered yet (Phase 5)", datasetTargets.list().length === 0)

{
  const registry = createDatasetRegistry()
  const field = { key: "sku", label: "SKU", importance: "required" as const, type: "text" as const, aliases: [] }
  check(
    "A SPREADSHEET CAN NEVER BE REGISTERED AS A LEDGER WRITER",
    throws(
      () =>
        registry.register({
          key: "LEDGER" as never, label: "x", identityField: "sku", fields: [field], suggestionsOnly: false, writer: "x",
        }),
      "never written from a spreadsheet"
    )
  )
  check(
    "nor as a confirmer of SKU mappings",
    throws(
      () =>
        registry.register({
          key: "SKU_ALIAS_SUGGESTIONS", label: "x", identityField: "sku", fields: [field], suggestionsOnly: false, writer: "x",
        }),
      "suggestions-only"
    )
  )
  check(
    "a target whose identity field it does not have is refused",
    throws(
      () =>
        registry.register({
          key: "COGS", label: "x", identityField: "internal_sku", fields: [field], suggestionsOnly: false, writer: "x",
        }),
      "identity field"
    )
  )
}

check(
  "the Google Sheets transport was not changed to use it in Phase 1",
  !walk("src/services/integrations").some((file) => readFileSync(file, "utf8").includes("services/datasets"))
)

/* -------------------------------------------------------------------------- */
section("6. THE NEW CODE CANNOT REACH AROUND THE DATABASE")

const newFiles = [...walk("src/services/marketplaces"), ...walk("src/services/datasets")]
check(
  "no new module mentions the service-role key",
  newFiles.every((file) => !readFileSync(file, "utf8").includes("SUPABASE_SERVICE_ROLE_KEY"))
)
check(
  "no new module creates its own Supabase client",
  newFiles.every((file) => !readFileSync(file, "utf8").includes("@supabase/supabase-js"))
)
check(
  "no new module inserts, updates or deletes a table directly",
  // A SHA-256 hash is not a table write: `createHash("sha256").update(text)` is the one call allowed.
  newFiles.every((file) => !/(?<!createHash\("sha256"\))\.(insert|update|upsert|delete)\(/.test(readFileSync(file, "utf8")))
)

const apply = readFileSync("src/services/marketplaces/apply.ts", "utf8")
const rpcs = [...apply.matchAll(/\.rpc\("([a-z_]+)"/g)].map((match) => match[1]).sort()
check(
  "the door calls exactly the three ledger functions, through the user's own session",
  JSON.stringify(rpcs) === JSON.stringify(["ledger_apply_file", "ledger_file_restore", "ledger_file_withdraw"]) &&
    apply.includes('from "@/lib/supabase/server"') &&
    apply.startsWith('import "server-only"'),
  rpcs.join(", ")
)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
