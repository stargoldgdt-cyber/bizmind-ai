/**
 * The marketplace ledger foundation, against the real database (0029, 0030).
 *
 * Run with:  npm run test:ledger
 *
 * Phase 1 of the GCC rebuild made promises the database itself must keep:
 *
 *   - a ledger row is never changed or deleted -- not by an owner, not by the
 *     service role -- except by deleting the whole business
 *   - exactly one function can write a ledger row
 *   - every row points at a source row of its own file and business
 *   - the same file twice writes nothing; a withdrawn file stops counting and
 *     comes back on restore, and its evidence is never destroyed
 *   - currency belongs to the account; blank stays unknown; no customer data
 *   - Business A cannot see or touch Business B
 *
 * Each is attacked here rather than assumed. The service-role key is required:
 * proving the service role CANNOT bypass the rules is part of the point.
 *
 * Two throwaway businesses and four throwaway GLOBAL mapping rules (with a
 * format id unique to this run) are created and removed at the end.
 */

import { createHash } from "node:crypto"

import { requireConfig, SUPABASE_SERVICE_ROLE_KEY } from "./test-env.mjs"

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

const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY ?? ""
if (SERVICE_KEY.length <= 20) {
  console.log(
    "\n  FAIL  SUPABASE_SERVICE_ROLE_KEY is not set in .env.local. This suite must prove the\n" +
      "        service role cannot bypass the ledger rules, so it cannot run without it.\n"
  )
  process.exit(1)
}

/* ---- REST helpers -------------------------------------------------------- */

type Json = ReturnType<typeof JSON.parse>
type Reply = { ok: boolean; status: number; body: Json }
type Caller = { apikey: string; bearer: string }

async function request(path: string, init: RequestInit, caller: Caller): Promise<Reply> {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: caller.apikey,
      Authorization: `Bearer ${caller.bearer}`,
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

const asUser = (token: string): Caller => ({ apikey: ANON_KEY, bearer: token })
const service: Caller = { apikey: SERVICE_KEY, bearer: SERVICE_KEY }

const rpc = (fn: string, args: unknown, caller: Caller) =>
  request(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, caller)
const read = (path: string, caller: Caller) => request(path, { method: "GET" }, caller)
const patch = (path: string, body: unknown, caller: Caller) =>
  request(path, { method: "PATCH", body: JSON.stringify(body) }, caller)
const insert = (table: string, body: unknown, caller: Caller) =>
  request(`/rest/v1/${table}`, { method: "POST", body: JSON.stringify(body) }, caller)
const remove = (path: string, caller: Caller) => request(path, { method: "DELETE" }, caller)

const say = (reply: Reply) => `${reply.status} ${JSON.stringify(reply.body).slice(0, 240)}`
const refusedWith = (reply: Reply, fragment: string) =>
  !reply.ok && JSON.stringify(reply.body).toLowerCase().includes(fragment.toLowerCase())
const rows = (reply: Reply): Json[] => (Array.isArray(reply.body) ? reply.body : [])

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(`Could not sign in as ${email}`)
  return (await response.json()).access_token
}

async function userIdOf(token: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  })
  return (await response.json()).id as string
}

const sha = (content: string) => createHash("sha256").update(content).digest("hex")

/* ---- Setup --------------------------------------------------------------- */

section("Setup -- two throwaway businesses and fixture mapping rules")

const owner = asUser(await signIn(EMAIL, PASSWORD))
const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const other = asUser(otherToken)
const otherId = await userIdOf(otherToken)

const suffix = Date.now().toString(36)
const FORMAT = `bizmind.phase1.fixture.${suffix}`

const createdA = await rpc(
  "create_business",
  { p_name: `Ledger Verify ${suffix}`, p_slug: `ledger-verify-${suffix}`, p_currency: "AED" },
  owner
)
const createdB = await rpc(
  "create_business",
  { p_name: `Ledger Rival ${suffix}`, p_slug: `ledger-rival-${suffix}`, p_currency: "AED" },
  other
)
if (!createdA.ok || !createdB.ok) {
  console.log(`  could not create the test businesses: ${say(createdA)} / ${say(createdB)}`)
  process.exit(1)
}
const businessId: string = createdA.body.id
const rivalId: string = createdB.body.id
let businessesDeleted = false
const ruleIds: string[] = []

async function seedRule(fields: Record<string, unknown>): Promise<string> {
  const reply = await insert(
    "ledger_mapping_rules",
    {
      marketplace_code: "AMAZON",
      format_id: FORMAT,
      match: { fixture: true },
      confidence: "PROVISIONAL",
      evidence: "Phase 1 live test fixture. Deleted when the run ends.",
      ...fields,
    },
    service
  )
  if (!reply.ok) throw new Error(`Could not seed a mapping rule: ${say(reply)}`)
  ruleIds.push(reply.body[0].id)
  return reply.body[0].id as string
}

async function setRole(role: "STAFF" | "ADMIN" | "VIEWER") {
  const reply = await patch(
    `/rest/v1/business_members?business_id=eq.${businessId}&user_id=eq.${otherId}`,
    { role },
    owner
  )
  if (!reply.ok) throw new Error(`Could not change the second user's role: ${say(reply)}`)
}

try {
  const REVENUE = await seedRule({
    match_key: "fixture:revenue", side: "PNL", category: "REVENUE", subcategory: "principal",
    quantity_rule: "REPORTED", attribution: "ORDER_LINE",
  })
  const PAYOUT = await seedRule({
    match_key: "fixture:payout", side: "CASH", category: "PAYOUT", subcategory: null,
    quantity_rule: "NONE", attribution: "MARKETPLACE",
  })
  const OTHER_FORMAT_RULE = await seedRule({
    format_id: `${FORMAT}.other`, match_key: "fixture:revenue", side: "PNL", category: "REVENUE",
    subcategory: "principal", quantity_rule: "REPORTED", attribution: "ORDER_LINE",
  })
  const RETIRED_RULE = await seedRule({
    match_key: "fixture:retired", side: "PNL", category: "REFUND", subcategory: "principal",
    quantity_rule: "NONE", attribution: "ORDER_LINE", status: "RETIRED",
  })
  console.log(`  businesses ${businessId} / ${rivalId}; format ${FORMAT}`)

  /* ------------------------------------------------------------------------ */
  section("1. MARKETPLACES, ACCOUNTS AND TAX PROFILES")

  const markets = await read("/rest/v1/marketplaces?select=code,adapter_status&order=code", owner)
  check(
    "the three marketplaces are listed",
    rows(markets).map((m) => m.code).join(",") === "AMAZON,CARREFOUR,NOON",
    say(markets)
  )
  check(
    "only Amazon is AVAILABLE -- its adapter shipped in Phase 2 (0031); noon and Carrefour have none",
    rows(markets)
      .filter((m) => m.adapter_status === "AVAILABLE")
      .map((m) => m.code)
      .join(",") === "AMAZON"
  )
  check(
    "a signed-in user cannot add a marketplace",
    !(await insert("marketplaces", { code: "FAKE", name: "Fake", adapter_status: "AVAILABLE" }, owner)).ok
  )

  const account = await rpc(
    "marketplace_account_create",
    { p_business_id: businessId, p_marketplace_code: "AMAZON", p_label: "Amazon.ae", p_country: "AE", p_currency: "AED" },
    owner
  )
  check("an owner creates a marketplace account", account.ok && typeof account.body === "string", say(account))
  if (!account.ok) throw new Error("No account; the rest of the suite cannot run.")
  const accountId: string = account.body

  const tax = await read(`/rest/v1/tax_profiles?select=*&marketplace_account_id=eq.${accountId}`, owner)
  check(
    "it comes with a tax profile that is UNCONFIGURED -- no VAT treatment is invented",
    rows(tax)[0]?.treatment === "UNCONFIGURED" && rows(tax)[0]?.vat_registration === "UNKNOWN",
    say(tax)
  )

  check(
    "the same account twice is refused",
    refusedWith(
      await rpc(
        "marketplace_account_create",
        { p_business_id: businessId, p_marketplace_code: "AMAZON", p_label: "Again", p_country: "AE", p_currency: "AED" },
        owner
      ),
      "already exists"
    )
  )
  check(
    "an account cannot be inserted directly",
    !(await insert(
      "marketplace_accounts",
      { business_id: businessId, marketplace_code: "AMAZON", label: "Direct", country: "SA", currency: "SAR" },
      owner
    )).ok
  )
  check(
    "a non-member cannot add an account to this business, and is told it does not exist",
    refusedWith(
      await rpc(
        "marketplace_account_create",
        { p_business_id: businessId, p_marketplace_code: "NOON", p_label: "x", p_country: "AE", p_currency: "AED" },
        other
      ),
      "could not be found"
    )
  )

  const joined = await insert("business_members", { business_id: businessId, user_id: otherId, role: "STAFF" }, owner)
  if (!joined.ok) throw new Error(`Could not add the second user: ${say(joined)}`)

  check(
    "B11: STAFF cannot add a marketplace account",
    refusedWith(
      await rpc(
        "marketplace_account_create",
        { p_business_id: businessId, p_marketplace_code: "NOON", p_label: "noon", p_country: "AE", p_currency: "AED" },
        other
      ),
      "Only an owner"
    )
  )
  await setRole("ADMIN")
  check(
    "B11: nor can ADMIN -- configuration is the owner's",
    refusedWith(
      await rpc(
        "marketplace_account_create",
        { p_business_id: businessId, p_marketplace_code: "NOON", p_label: "noon", p_country: "AE", p_currency: "AED" },
        other
      ),
      "Only an owner"
    )
  )
  check(
    "B11: an admin cannot change tax settings",
    refusedWith(
      await rpc("tax_profile_update", { p_account_id: accountId, p_vat_registration: "REGISTERED" }, other),
      "Only an owner"
    )
  )
  await setRole("STAFF")

  const taxUpdate = await rpc(
    "tax_profile_update",
    { p_account_id: accountId, p_vat_registration: "REGISTERED", p_note: "Awaiting the accountant" },
    owner
  )
  const taxAfter = await read(`/rest/v1/tax_profiles?select=*&marketplace_account_id=eq.${accountId}`, owner)
  check(
    "an owner records VAT registration, and the treatment stays UNCONFIGURED",
    taxUpdate.ok && rows(taxAfter)[0]?.vat_registration === "REGISTERED" && rows(taxAfter)[0]?.treatment === "UNCONFIGURED",
    say(taxUpdate)
  )
  check(
    "a VAT treatment cannot be set by writing the table",
    !(await patch(`/rest/v1/tax_profiles?marketplace_account_id=eq.${accountId}`, { treatment: "NET_OF_VAT" }, owner)).ok
  )

  /* ------------------------------------------------------------------------ */
  section("2. THE ONE WRITER")

  const S1 = `S1-${suffix}`

  function tx(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      line_index: 0, source_type: "Order", source_subtype: null, source_description: null,
      currency: "AED", posted_at: "2026-09-01T10:00:00Z", order_ref: "403-1234567-1234567",
      order_line_ref: null, raw_sku: null, quantity: null, quantity_basis: null,
      settlement_ref: null, payout_ref: null,
      ...fields,
    }
  }

  function fileOne(overrides: Record<string, unknown> = {}) {
    return {
      marketplace_account_id: accountId,
      format_id: FORMAT,
      adapter_version: "0.0.1-test",
      file_name: "settlement-one.csv",
      file_type: "csv",
      file_size_bytes: 2048,
      file_sha256: sha(`one-${suffix}`),
      source_kind: "UPLOAD",
      columns: ["settlement-id", "total-amount", "deposit-date", "amount", "amount-description", "sku",
        "quantity-purchased", "posted-date-time", "buyer-name", "buyer-email"],
      stripped_columns: ["buyer-name", "buyer-email"],
      rows: [
        { row_number: 1, raw: { "settlement-id": S1, "total-amount": "1049.50", "deposit-date": null, amount: null } as Record<string, string | null> },
        { row_number: 2, raw: { "settlement-id": S1, amount: "1200.00", "amount-description": "Principal", sku: "SKU-1", "quantity-purchased": "2", "posted-date-time": "2026-09-01 10:00:00 UTC" } as Record<string, string | null> },
        { row_number: 3, raw: { "settlement-id": S1, amount: "-150.50", "amount-description": "MysteryFee", "posted-date-time": "2026-09-02 10:00:00 UTC" } as Record<string, string | null> },
        { row_number: 4, raw: { "settlement-id": S1, amount: "1049.50", "amount-description": "Payout" } as Record<string, string | null> },
        { row_number: 5, raw: { "settlement-id": S1, amount: "12,00", "posted-date-time": "not a date" } as Record<string, string | null> },
      ],
      settlements: [
        { external_settlement_id: S1, source_row_number: 1, period_start: null, period_end: null, reported_total: "1049.50", reported_deposit_date: null, currency: "AED" } as Record<string, unknown>,
      ],
      payouts: [
        { key: "P1", source_row_number: 4, external_ref: null, amount: "1049.50", currency: "AED", paid_at: null, settlement_ref: S1 } as Record<string, unknown>,
      ],
      transactions: [
        tx({ source_row_number: 2, mapping_rule_id: REVENUE, side: "PNL", category: "REVENUE", subcategory: "principal", amount: "1200.00", raw_sku: "SKU-1", quantity: "2", quantity_basis: "REPORTED", attribution: "ORDER_LINE", source_description: "Principal", settlement_ref: S1 }),
        tx({ source_row_number: 3, mapping_rule_id: null, side: null, category: "UNMAPPED", subcategory: null, amount: "-150.50", attribution: "ORDER_LINE", source_description: "MysteryFee", posted_at: "2026-09-02T10:00:00Z", settlement_ref: S1 }),
        tx({ source_row_number: 4, mapping_rule_id: PAYOUT, side: "CASH", category: "PAYOUT", subcategory: null, amount: "1049.50", attribution: "MARKETPLACE", source_description: "Payout", settlement_ref: S1, payout_ref: "P1" }),
      ],
      issues: [
        { row_number: 5, severity: "ERROR", field: "posted-date-time", message: "The date could not be read.", raw_value: "not a date" } as Record<string, unknown>,
      ],
      ...overrides,
    }
  }

  type LedgerFile = ReturnType<typeof fileOne>

  /** A copy of file one with its own fingerprint and settlement id, then changed. */
  function freshFile(label: string, change: (file: LedgerFile) => void = () => {}): LedgerFile {
    const sid = `S-${label}-${suffix}`
    const file = fileOne({ file_sha256: sha(`${label}-${suffix}`) })
    file.rows = file.rows.map((row) => ({ ...row, raw: { ...row.raw, "settlement-id": sid } }))
    file.settlements = file.settlements.map((s) => ({ ...s, external_settlement_id: sid }))
    file.payouts = file.payouts.map((p) => ({ ...p, settlement_ref: sid }))
    file.transactions = file.transactions.map((t) => ({ ...t, settlement_ref: t.settlement_ref ? sid : null }))
    change(file)
    return file
  }

  const apply = (file: unknown, caller: Caller = owner) => rpc("ledger_apply_file", { p_file: file }, caller)
  const countFiles = async () =>
    rows(await read(`/rest/v1/import_batches?select=id&marketplace_account_id=eq.${accountId}`, owner)).length
  const countLines = async () =>
    rows(await read(`/rest/v1/financial_transactions?select=id&business_id=eq.${businessId}`, owner)).length

  const applied = await apply(fileOne())
  const result = rows(applied)[0]
  check("AN OWNER APPLIES A LEDGER FILE", applied.ok && result?.duplicate === false, say(applied))
  if (!applied.ok) throw new Error("The first file did not apply; the rest of the suite cannot run.")
  check(
    "everything is written in one go: 5 rows, 3 transactions, 1 settlement, 1 payout, 1 row issue, 1 unmapped",
    result.rows_written === 5 && result.transactions_written === 3 && result.settlements_written === 1 &&
      result.payouts_written === 1 && result.issues_written === 1 && result.unmapped_written === 1,
    JSON.stringify(result)
  )
  const file1: string = result.source_file_id

  const insertAttempt = await insert(
    "financial_transactions",
    {
      business_id: businessId, marketplace_account_id: accountId, source_file_id: file1, source_row_id: 1,
      category: "UNMAPPED", amount: "1.00", currency: "AED", posted_at: "2026-09-01T00:00:00Z", attribution: "ORDER",
    },
    owner
  )
  check("A SIGNED-IN OWNER CANNOT INSERT A LEDGER ROW DIRECTLY", !insertAttempt.ok, say(insertAttempt))

  const serviceInsert = await insert(
    "financial_transactions",
    {
      business_id: businessId, marketplace_account_id: accountId, source_file_id: file1, source_row_id: 1,
      category: "UNMAPPED", amount: "1.00", currency: "AED", posted_at: "2026-09-01T00:00:00Z", attribution: "ORDER",
    },
    service
  )
  check(
    "AND NEITHER CAN THE SERVICE ROLE -- only ledger_apply_file() writes the ledger",
    refusedWith(serviceInsert, "ledger_apply_file"),
    say(serviceInsert)
  )
  for (const table of ["source_rows", "settlements", "payouts"]) {
    const attempt = await insert(table, { business_id: businessId }, service)
    check(
      `the service role cannot insert into ${table} either`,
      refusedWith(attempt, "ledger_apply_file") || refusedWith(attempt, "ledger functions"),
      say(attempt)
    )
  }
  const fakeFile = await insert(
    "import_batches",
    { business_id: businessId, entity: "ORDERS", file_name: "fake.csv", file_type: "csv", file_size_bytes: 1, dataset: "LEDGER" },
    owner
  )
  check("a ledger file record cannot be created outside the writer", refusedWith(fakeFile, "ledger_apply_file"), say(fakeFile))

  /* ------------------------------------------------------------------------ */
  section("3. BLANK STAYS UNKNOWN; MONEY STAYS EXACT")

  const settlementView = rows(await read(`/rest/v1/ledger_settlements?select=*&source_file_id=eq.${file1}`, owner))[0]
  check(
    "the settlement's reported total is exact text",
    settlementView?.reported_total === "1049.5000",
    JSON.stringify(settlementView)
  )
  check(
    "ITS BLANK DEPOSIT DATE AND PERIOD STAY NULL -- never a made-up date",
    settlementView?.reported_deposit_date === null && settlementView?.period_start === null && settlementView?.period_end === null
  )

  const lines1 = rows(await read(`/rest/v1/ledger_lines?select=*&source_file_id=eq.${file1}&order=source_row_id`, owner))
  const revenueLine = lines1.find((line) => line.category === "REVENUE")
  const unmappedLine = lines1.find((line) => line.category === "UNMAPPED")
  check(
    "ledger amounts and quantities come back as exact text",
    revenueLine?.amount === "1200.0000" && revenueLine?.quantity === "2.0000",
    JSON.stringify(revenueLine)
  )
  check(
    "an UNMAPPED line keeps its amount, has no side, and a blank quantity stays null",
    unmappedLine?.amount === "-150.5000" && unmappedLine?.side === null && unmappedLine?.quantity === null,
    JSON.stringify(unmappedLine)
  )

  const sourceRows1 = rows(await read(`/rest/v1/source_rows?select=row_number,raw,row_hash&source_file_id=eq.${file1}&order=row_number`, owner))
  check(
    "A BLANK SOURCE CELL IS STORED AS NULL, not \"\" and not 0",
    sourceRows1[0]?.raw?.["deposit-date"] === null && sourceRows1[0]?.raw?.amount === null,
    JSON.stringify(sourceRows1[0])
  )
  check(
    "source text is stored exactly as read (\"12,00\" is not reinterpreted)",
    sourceRows1[4]?.raw?.amount === "12,00"
  )
  check(
    "every source row carries a SHA-256 fingerprint computed by the database",
    sourceRows1.length === 5 && sourceRows1.every((row) => /^[0-9a-f]{64}$/.test(row.row_hash))
  )

  check(
    "A BLANK AMOUNT CANNOT BECOME A TRANSACTION -- it must be a row issue",
    refusedWith(await apply(freshFile("blank-amount", (f) => { f.transactions[0].amount = null })), "blank")
  )
  check(
    "a JSON number is refused as an amount: money travels as exact text",
    refusedWith(await apply(freshFile("number-amount", (f) => { f.transactions[0].amount = 1200 })), "exact decimal")
  )
  check(
    "a fifth decimal place is refused rather than rounded",
    refusedWith(await apply(freshFile("five-decimals", (f) => { f.transactions[0].amount = "1200.00001" })), "exact decimal")
  )
  check(
    "a timestamp without a time zone is refused",
    refusedWith(await apply(freshFile("no-zone", (f) => { f.transactions[0].posted_at = "2026-09-01 10:00:00" })), "time zone")
  )

  /* ------------------------------------------------------------------------ */
  section("4. EVERY ROW HAS LINEAGE")

  const allLines = rows(await read(`/rest/v1/financial_transactions?select=id,business_id,source_file_id,source_row_id&business_id=eq.${businessId}`, owner))
  const allSourceRows = rows(await read(`/rest/v1/source_rows?select=id,business_id,source_file_id&business_id=eq.${businessId}`, owner))
  const sourceById = new Map(allSourceRows.map((row) => [row.id, row]))
  check(
    "EVERY LEDGER ROW POINTS AT A SOURCE ROW OF ITS OWN FILE AND ITS OWN BUSINESS",
    allLines.length === 3 &&
      allLines.every((line) => {
        const source = sourceById.get(line.source_row_id)
        return source && source.source_file_id === line.source_file_id && source.business_id === line.business_id
      }),
    `${allLines.length} lines`
  )

  const settlementsBase = rows(await read(`/rest/v1/settlements?select=source_file_id,source_row_id&business_id=eq.${businessId}`, owner))
  const payoutsBase = rows(await read(`/rest/v1/payouts?select=source_file_id,source_row_id,origin&business_id=eq.${businessId}`, owner))
  check(
    "settlements and payouts carry the same lineage",
    [...settlementsBase, ...payoutsBase].every((row) => sourceById.get(row.source_row_id)?.source_file_id === row.source_file_id) &&
      payoutsBase.every((row) => row.origin === "SOURCE_FILE")
  )

  const fileRecord = rows(await read(`/rest/v1/import_batches?select=*&id=eq.${file1}`, owner))[0]
  check(
    "the file record carries its fingerprint, format, adapter version and account",
    fileRecord?.dataset === "LEDGER" && fileRecord?.entity === "LEDGER" && fileRecord?.file_sha256 === sha(`one-${suffix}`) &&
      fileRecord?.format_id === FORMAT && fileRecord?.adapter_version === "0.0.1-test" &&
      fileRecord?.marketplace_account_id === accountId && fileRecord?.status === "COMPLETED",
    JSON.stringify(fileRecord).slice(0, 300)
  )
  check(
    "and the NAMES of the columns removed before storage",
    JSON.stringify(fileRecord?.stripped_columns) === JSON.stringify(["buyer-name", "buyer-email"])
  )
  check("no copy of the raw file is kept on the record (decision B6)", JSON.stringify(fileRecord?.raw_rows) === "[]")

  check(
    "A TRANSACTION POINTING AT NO SOURCE ROW IS REFUSED",
    refusedWith(await apply(freshFile("no-lineage", (f) => { f.transactions[0].source_row_number = 99 })), "no lineage")
  )
  check(
    "A SOURCE ROW NOTHING ACCOUNTS FOR IS REFUSED -- nothing is dropped silently",
    refusedWith(await apply(freshFile("unaccounted", (f) => { f.issues = [] })), "not used by any")
  )
  check(
    "a row issue pointing at no source row is refused",
    refusedWith(await apply(freshFile("issue-no-row", (f) => { f.issues[0].row_number = 99 })), "matches no source row")
  )

  /* ------------------------------------------------------------------------ */
  section("5. THE LEDGER CANNOT BE CHANGED")

  const firstLineId = allLines[0].id
  const firstSourceRowId = allSourceRows[0].id

  check(
    "an owner cannot update a ledger row",
    !(await patch(`/rest/v1/financial_transactions?id=eq.${firstLineId}`, { source_description: "edited" }, owner)).ok
  )
  check(
    "an owner cannot delete a ledger row",
    !(await remove(`/rest/v1/financial_transactions?id=eq.${firstLineId}`, owner)).ok
  )

  const servicePatch = await patch(`/rest/v1/financial_transactions?id=eq.${firstLineId}`, { source_description: "edited" }, service)
  check("THE SERVICE ROLE CANNOT UPDATE A LEDGER ROW", refusedWith(servicePatch, "cannot be changed"), say(servicePatch))
  const serviceDelete = await remove(`/rest/v1/financial_transactions?id=eq.${firstLineId}`, service)
  check("THE SERVICE ROLE CANNOT DELETE A LEDGER ROW", refusedWith(serviceDelete, "cannot be deleted"), say(serviceDelete))

  check(
    "nor change or delete a source row",
    refusedWith(await patch(`/rest/v1/source_rows?id=eq.${firstSourceRowId}`, { row_hash: "0".repeat(64) }, service), "cannot be changed") &&
      refusedWith(await remove(`/rest/v1/source_rows?id=eq.${firstSourceRowId}`, service), "cannot be deleted")
  )
  check(
    "nor change a settlement",
    refusedWith(await patch(`/rest/v1/settlements?source_file_id=eq.${file1}`, { reported_total: "1.00" }, service), "cannot be changed")
  )
  check(
    "nor change a payout",
    refusedWith(await patch(`/rest/v1/payouts?source_file_id=eq.${file1}`, { amount: "1.00" }, service), "cannot be changed")
  )
  check(
    "nor edit a mapping rule in place",
    refusedWith(await patch(`/rest/v1/ledger_mapping_rules?id=eq.${REVENUE}`, { category: "REFUND" }, service), "cannot be edited")
  )

  check(
    "a ledger file's record cannot be edited",
    refusedWith(await patch(`/rest/v1/import_batches?id=eq.${file1}`, { file_name: "renamed.csv" }, owner), "cannot be edited")
  )
  check(
    "nor deleted",
    refusedWith(await remove(`/rest/v1/import_batches?id=eq.${file1}`, owner), "cannot be deleted")
  )
  check(
    "nor withdrawn by writing the table",
    refusedWith(await patch(`/rest/v1/import_batches?id=eq.${file1}`, { withdrawn_at: new Date().toISOString() }, owner), "ledger_file_withdraw")
  )
  check(
    "its row issues cannot be deleted",
    refusedWith(await remove(`/rest/v1/import_issues?batch_id=eq.${file1}`, owner), "cannot be deleted")
  )
  check(
    "and no new row issue can be attached to it",
    refusedWith(
      await insert("import_issues", { business_id: businessId, batch_id: file1, row_number: 1, severity: "ERROR", message: "forged" }, owner),
      "ledger_apply_file"
    )
  )

  const linesAfterAttacks = rows(await read(`/rest/v1/ledger_lines?select=id,source_description&source_file_id=eq.${file1}`, owner))
  check(
    "after every attempt, the ledger is exactly as it was",
    linesAfterAttacks.length === 3 && !linesAfterAttacks.some((line) => line.source_description === "edited") &&
      rows(await read(`/rest/v1/import_issues?select=id&batch_id=eq.${file1}`, owner)).length === 1
  )

  /* ------------------------------------------------------------------------ */
  section("6. THE SAME FILE TWICE WRITES NOTHING")

  const duplicate = await apply(fileOne())
  check(
    "APPLYING THE SAME FILE AGAIN RETURNS THE ORIGINAL AND WRITES NOTHING",
    duplicate.ok && rows(duplicate)[0]?.duplicate === true && rows(duplicate)[0]?.source_file_id === file1,
    say(duplicate)
  )
  check("still one file, still three ledger rows", (await countFiles()) === 1 && (await countLines()) === 3)

  const sameSettlement = await apply(fileOne({ file_sha256: sha(`one-edited-${suffix}`) }))
  check(
    "A DIFFERENT FILE CARRYING THE SAME SETTLEMENT IS REFUSED, naming the file already counting it (B8)",
    refusedWith(sameSettlement, "already counted") && refusedWith(sameSettlement, "settlement-one.csv"),
    say(sameSettlement)
  )

  /* ------------------------------------------------------------------------ */
  section("7. WHO MAY IMPORT (B11)")

  const staffApply = await apply(freshFile("two"), other)
  check("STAFF may import a ledger file", staffApply.ok && rows(staffApply)[0]?.duplicate === false, say(staffApply))
  const file2: string = rows(staffApply)[0]?.source_file_id

  await setRole("VIEWER")
  check("a VIEWER may not", refusedWith(await apply(freshFile("viewer"), other), "viewer cannot import"))
  await setRole("STAFF")

  /* ------------------------------------------------------------------------ */
  section("8. CURRENCY BELONGS TO THE ACCOUNT")

  const filesBefore = await countFiles()
  check(
    "A TRANSACTION IN ANOTHER CURRENCY IS REFUSED",
    refusedWith(await apply(freshFile("sar-tx", (f) => { f.transactions[0].currency = "SAR" })), "does not match the account currency")
  )
  check(
    "so is a settlement",
    refusedWith(await apply(freshFile("sar-settlement", (f) => { f.settlements[0].currency = "SAR" })), "does not match the account currency")
  )
  check(
    "and a payout",
    refusedWith(await apply(freshFile("sar-payout", (f) => { f.payouts[0].currency = "SAR" })), "does not match the account currency")
  )
  check("a refused file writes nothing at all", (await countFiles()) === filesBefore)

  check(
    "THE ACCOUNT'S CURRENCY IS LOCKED ONCE DATA EXISTS",
    refusedWith(await rpc("marketplace_account_update", { p_account_id: accountId, p_currency: "SAR" }, owner), "locked")
  )
  const relabel = await rpc("marketplace_account_update", { p_account_id: accountId, p_label: "Amazon.ae main" }, owner)
  check("its label can still change", relabel.ok, say(relabel))

  /* ------------------------------------------------------------------------ */
  section("9. NO CUSTOMER DATA")

  check(
    "A SOURCE ROW WITH A BUYER-EMAIL COLUMN IS REFUSED",
    refusedWith(await apply(freshFile("pii-column", (f) => { f.rows[1].raw["buyer-email"] = null })), "customer-data column")
  )
  check(
    "so is a \"Customer Name\" column, even when blank",
    refusedWith(await apply(freshFile("pii-name", (f) => { f.rows[1].raw["Customer Name"] = null })), "customer-data column")
  )
  check(
    "AN EMAIL ADDRESS INSIDE AN ORDINARY COLUMN IS REFUSED",
    refusedWith(await apply(freshFile("pii-value", (f) => { f.rows[2].raw["amount-description"] = "Refund to ali@example.com" })), "email")
  )
  check(
    "AN EMAIL ADDRESS IN A LEDGER FIELD IS REFUSED",
    refusedWith(await apply(freshFile("pii-ledger", (f) => { f.transactions[1].source_description = "ali@example.com" })), "email")
  )
  check(
    "in a row issue's value",
    refusedWith(await apply(freshFile("pii-issue", (f) => { f.issues[0].raw_value = "ali@example.com" })), "email")
  )
  check(
    "in a settlement id",
    refusedWith(await apply(freshFile("pii-settlement", (f) => {
      f.settlements[0].external_settlement_id = "ali@example.com"
      f.payouts[0].settlement_ref = "ali@example.com"
      f.transactions = f.transactions.map((t) => ({ ...t, settlement_ref: t.settlement_ref ? "ali@example.com" : null }))
    })), "external_settlement_id")
  )
  check(
    "and in a file name",
    refusedWith(await apply(freshFile("pii-file", (f) => { f.file_name = "ali@example.com.csv" })), "email")
  )

  const storedRows = rows(await read(`/rest/v1/source_rows?select=raw&business_id=eq.${businessId}`, owner))
  const storedLines = rows(await read(`/rest/v1/ledger_lines?select=*&business_id=eq.${businessId}`, owner))
  const customerKey = /(buyer|customer|recipient|e-?mail|phone|address)/i
  check(
    "NOTHING STORED CONTAINS AN EMAIL ADDRESS OR A CUSTOMER COLUMN",
    storedRows.every((row) => !JSON.stringify(row.raw).includes("@") && !Object.keys(row.raw).some((key) => customerKey.test(key))) &&
      storedLines.every((line) => !JSON.stringify(line).includes("@")),
    `${storedRows.length} rows, ${storedLines.length} lines`
  )

  /* ------------------------------------------------------------------------ */
  section("10. CLASSIFICATION COMES FROM THE RULES")

  check(
    "a line whose category differs from its rule is refused",
    refusedWith(await apply(freshFile("rule-category", (f) => { f.transactions[0].category = "REFUND" })), "differ from its mapping rule")
  )
  check(
    "an UNMAPPED line cannot carry a rule",
    refusedWith(await apply(freshFile("unmapped-rule", (f) => { f.transactions[1].mapping_rule_id = REVENUE })), "differ from its mapping rule")
  )
  check(
    "a classified line without a rule is refused",
    refusedWith(await apply(freshFile("no-rule", (f) => { f.transactions[0].mapping_rule_id = null })), "must be UNMAPPED")
  )
  check(
    "a rule for another format cannot be used",
    refusedWith(await apply(freshFile("other-format", (f) => { f.transactions[0].mapping_rule_id = OTHER_FORMAT_RULE })), "different marketplace or format")
  )
  check(
    "a retired rule cannot be used",
    refusedWith(
      await apply(freshFile("retired", (f) => {
        f.transactions[0] = { ...f.transactions[0], mapping_rule_id: RETIRED_RULE, category: "REFUND", quantity: null, quantity_basis: null }
      })),
      "retired"
    )
  )
  check(
    "a rule's quantity rule is enforced",
    refusedWith(await apply(freshFile("quantity-rule", (f) => { f.transactions[0].quantity_basis = "DERIVED_LINE_COUNT" })), "quantity as reported")
  )

  /* ------------------------------------------------------------------------ */
  section("11. WITHDRAW AND RESTORE")

  check(
    "STAFF cannot withdraw a file",
    refusedWith(await rpc("ledger_file_withdraw", { p_source_file_id: file1, p_reason: "Wrong file" }, other), "owner or admin")
  )
  await setRole("ADMIN")

  const withdrawn = await rpc("ledger_file_withdraw", { p_source_file_id: file1, p_reason: "Wrong file" }, other)
  check(
    "AN ADMIN WITHDRAWS A FILE: 3 transactions, 1 settlement, 1 payout",
    withdrawn.ok && rows(withdrawn)[0]?.transactions_withdrawn === 3 &&
      rows(withdrawn)[0]?.settlements_withdrawn === 1 && rows(withdrawn)[0]?.payouts_withdrawn === 1,
    say(withdrawn)
  )

  const scope = async (view: string, fileId: string) =>
    rows(await read(`/rest/v1/${view}?select=id&source_file_id=eq.${fileId}`, owner)).length

  check(
    "ITS LINES, SETTLEMENT AND PAYOUT LEAVE THE COUNTING SCOPE",
    (await scope("ledger_lines", file1)) === 0 && (await scope("ledger_settlements", file1)) === 0 &&
      (await scope("ledger_payouts", file1)) === 0
  )
  check(
    "BUT NOTHING IS DESTROYED: every ledger row, source row and row issue is still there",
    rows(await read(`/rest/v1/financial_transactions?select=id&source_file_id=eq.${file1}`, owner)).length === 3 &&
      rows(await read(`/rest/v1/source_rows?select=id&source_file_id=eq.${file1}`, owner)).length === 5 &&
      rows(await read(`/rest/v1/settlements?select=id&source_file_id=eq.${file1}`, owner)).length === 1 &&
      rows(await read(`/rest/v1/import_issues?select=id&batch_id=eq.${file1}`, owner)).length === 1
  )
  check("the other file still counts", (await scope("ledger_lines", file2)) === 3)

  const withdrawAudit = rows(await read(
    `/rest/v1/audit_logs?select=action,after_data&business_id=eq.${businessId}&action=eq.ledger.file_withdrawn`,
    owner
  ))
  check(
    "the withdrawal is audited with its counts, totals and reason",
    withdrawAudit.length === 1 && withdrawAudit[0].after_data.transactions === 3 &&
      withdrawAudit[0].after_data.reason === "Wrong file" && typeof withdrawAudit[0].after_data.totals === "object",
    JSON.stringify(withdrawAudit)
  )
  check(
    "withdrawing it twice is refused",
    refusedWith(await rpc("ledger_file_withdraw", { p_source_file_id: file1 }, other), "already been withdrawn")
  )

  const legacyWithdraw = await rpc("import_batch_withdraw", { p_batch_id: file2 }, owner)
  check(
    "the legacy withdrawal function cannot withdraw a ledger file",
    !legacyWithdraw.ok && (await scope("ledger_lines", file2)) === 3,
    say(legacyWithdraw)
  )

  const reapplied = await apply(fileOne())
  check(
    "once withdrawn, the same file can be applied again as a new file",
    reapplied.ok && rows(reapplied)[0]?.duplicate === false && rows(reapplied)[0]?.source_file_id !== file1,
    say(reapplied)
  )
  const file1b: string = rows(reapplied)[0]?.source_file_id

  check(
    "RESTORE IS REFUSED WHILE AN IDENTICAL FILE COUNTS -- nothing is ever double counted",
    refusedWith(await rpc("ledger_file_restore", { p_source_file_id: file1 }, owner), "identical file")
  )

  await rpc("ledger_file_withdraw", { p_source_file_id: file1b, p_reason: "Restoring the original" }, owner)
  const restored = await rpc("ledger_file_restore", { p_source_file_id: file1 }, owner)
  check(
    "RESTORE BRINGS THE ORIGINAL BACK: 3 transactions, 1 settlement, 1 payout",
    restored.ok && rows(restored)[0]?.transactions_restored === 3 && (await scope("ledger_lines", file1)) === 3 &&
      (await scope("ledger_settlements", file1)) === 1 && (await scope("ledger_payouts", file1)) === 1,
    say(restored)
  )
  check(
    "the restore is audited",
    rows(await read(`/rest/v1/audit_logs?select=id&business_id=eq.${businessId}&action=eq.ledger.file_restored`, owner)).length === 1
  )
  check(
    "restoring a file that is not withdrawn is refused",
    refusedWith(await rpc("ledger_file_restore", { p_source_file_id: file1 }, owner), "not withdrawn")
  )

  await rpc("ledger_file_withdraw", { p_source_file_id: file2 }, owner)
  const replacement = await apply(freshFile("two", (f) => { f.file_sha256 = sha(`two-replacement-${suffix}`) }))
  check("a replacement file for a withdrawn settlement applies", replacement.ok, say(replacement))
  check(
    "AND THE WITHDRAWN ORIGINAL CANNOT BE RESTORED ON TOP OF IT (B8)",
    refusedWith(await rpc("ledger_file_restore", { p_source_file_id: file2 }, owner), "already counted")
  )

  /* ------------------------------------------------------------------------ */
  section("12. BUSINESS A CANNOT SEE OR TOUCH BUSINESS B")

  const left = await remove(`/rest/v1/business_members?business_id=eq.${businessId}&user_id=eq.${otherId}`, owner)
  if (!left.ok) throw new Error(`Could not remove the second user: ${say(left)}`)

  for (const table of [
    "marketplace_accounts", "tax_profiles", "source_rows", "financial_transactions",
    "settlements", "payouts", "ledger_lines", "ledger_settlements", "ledger_payouts",
  ]) {
    const seen = await read(`/rest/v1/${table}?select=business_id&business_id=eq.${businessId}`, other)
    check(`an outsider sees no ${table} rows of this business`, seen.ok && rows(seen).length === 0, say(seen))
  }
  check(
    "nor its ledger files",
    rows(await read(`/rest/v1/import_batches?select=id&business_id=eq.${businessId}`, other)).length === 0
  )

  const outsiderWithdraw = await rpc("ledger_file_withdraw", { p_source_file_id: file1 }, other)
  const missingWithdraw = await rpc("ledger_file_withdraw", { p_source_file_id: "00000000-0000-4000-8000-000000000000" }, other)
  check(
    "AN OUTSIDER CANNOT WITHDRAW A FILE, and cannot tell it exists",
    refusedWith(outsiderWithdraw, "could not be found") &&
      JSON.stringify(outsiderWithdraw.body?.message) === JSON.stringify(missingWithdraw.body?.message),
    `${say(outsiderWithdraw)} vs ${say(missingWithdraw)}`
  )
  check(
    "nor restore one",
    refusedWith(await rpc("ledger_file_restore", { p_source_file_id: file1b }, other), "could not be found")
  )
  check(
    "nor apply a file into this business's account",
    refusedWith(await apply(freshFile("outsider"), other), "could not be found")
  )
  check(
    "nor change its account or tax settings",
    refusedWith(await rpc("marketplace_account_update", { p_account_id: accountId, p_label: "hijacked" }, other), "could not be found") &&
      refusedWith(await rpc("tax_profile_update", { p_account_id: accountId, p_vat_registration: "NOT_REGISTERED" }, other), "could not be found")
  )

  const rivalAccount = await rpc(
    "marketplace_account_create",
    { p_business_id: rivalId, p_marketplace_code: "AMAZON", p_label: "Rival Amazon", p_country: "AE", p_currency: "AED" },
    other
  )
  const rivalApply = await apply({ ...fileOne(), marketplace_account_id: rivalAccount.body }, other)
  check(
    "the rival's identical file in ITS OWN account is its own business, not a duplicate of ours",
    rivalAccount.ok && rivalApply.ok && rows(rivalApply)[0]?.duplicate === false,
    `${say(rivalAccount)} / ${say(rivalApply)}`
  )
  check(
    "and the owner of Business A sees none of it",
    rows(await read(`/rest/v1/financial_transactions?select=id&business_id=eq.${rivalId}`, owner)).length === 0 &&
      rows(await read(`/rest/v1/source_rows?select=id&business_id=eq.${rivalId}`, owner)).length === 0
  )

  /* ------------------------------------------------------------------------ */
  section("13. DELETING A BUSINESS STILL WORKS THROUGH THE IMMUTABLE TABLES")

  const deletedA = await remove(`/rest/v1/businesses?id=eq.${businessId}`, owner)
  const deletedB = await remove(`/rest/v1/businesses?id=eq.${rivalId}`, other)
  check("business A can be deleted", deletedA.ok, say(deletedA))
  check("business B can be deleted", deletedB.ok, say(deletedB))
  businessesDeleted = deletedA.ok && deletedB.ok

  for (const table of ["financial_transactions", "source_rows", "settlements", "payouts", "marketplace_accounts", "tax_profiles", "import_batches"]) {
    const leftover = await read(`/rest/v1/${table}?select=business_id&business_id=in.(${businessId},${rivalId})`, service)
    check(`and none of its ${table} rows remain`, leftover.ok && rows(leftover).length === 0, say(leftover))
  }
} catch (error) {
  failed += 1
  console.log(`\n  FAIL  the suite stopped early: ${(error as Error).message}`)
} finally {
  if (!businessesDeleted) {
    await remove(`/rest/v1/businesses?id=eq.${businessId}`, owner)
    await remove(`/rest/v1/businesses?id=eq.${rivalId}`, other)
  }
  if (ruleIds.length > 0) {
    const cleaned = await remove(`/rest/v1/ledger_mapping_rules?id=in.(${ruleIds.join(",")})`, service)
    if (!cleaned.ok) console.log(`  note: fixture mapping rules could not be removed: ${say(cleaned)}`)
  }

  console.log(`\n${"=".repeat(74)}`)
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log("=".repeat(74))
}

process.exit(failed === 0 ? 0 : 1)
