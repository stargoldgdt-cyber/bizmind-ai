/**
 * Canonical mapping, against the real database.
 *
 * Run with:  npm run test:mapping-data
 *
 * The offline suite proves the suggestion engine will not confirm anything.
 * This one proves the database will not let it -- which is the guarantee that
 * still holds when the application code is wrong.
 *
 * Everything runs in throwaway tenants that are deleted at the end.
 *
 * Credentials come from .env.test.local. The second sign-in is not optional
 * here: proving one business cannot read another's mappings needs two people.
 */

import { requireConfig } from "./test-env.mjs"

import { CANONICAL_METRICS } from "../src/services/metrics/canonical"
import { columnSignature } from "../src/services/ingestion/canonical-mapping"
import { AMAZON_SETTLEMENT } from "../src/services/ingestion/source-fields"

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

/* ---- REST helpers -------------------------------------------------------- */

let token = ""

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    console.error(`Could not sign in as ${email}.`)
    process.exit(1)
  }
  return (await response.json()).access_token
}

async function api(path: string, init: RequestInit = {}, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Authorization: `Bearer ${asToken}`,
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`)
  return body
}

/** Returns the failure instead of throwing, for the cases that must be refused. */
async function attempt(path: string, init: RequestInit = {}, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Authorization: `Bearer ${asToken}`,
      ...(init.headers ?? {}),
    },
  })
  return { ok: response.ok, status: response.status, body: await response.text() }
}

const rpc = (fn: string, args: unknown, asToken = token) =>
  api(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

const tryRpc = (fn: string, args: unknown, asToken = token) =>
  attempt(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

/* ---- Setup --------------------------------------------------------------- */

token = await signIn(EMAIL, PASSWORD)
const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)

section("Setup")
const suffix = Date.now().toString(36)

const business = await rpc("create_business", {
  p_name: `Mapping ${suffix}`,
  p_slug: `mapping-${suffix}`,
  p_currency: "AED",
})
const businessId = business.id as string

const otherBusiness = await rpc(
  "create_business",
  {
    p_name: `Rival ${suffix}`,
    p_slug: `rival-${suffix}`,
    p_currency: "AED",
  },
  otherToken
)
const otherBusinessId = otherBusiness.id as string

console.log(`  tenant A: ${business.name}`)
console.log(`  tenant B: ${otherBusiness.name} (a different person)`)

try {
  /* ---------------------------------------------------------------------- */
  section("1. THE VOCABULARY IS THE SAME IN BOTH PLACES")

  // The definitions live in TypeScript; the enforcement lives in SQL. If the
  // two drift, a legitimate mapping starts being refused, or worse, an
  // illegitimate one stops being.
  const dbMetrics: { key: string; origin: string }[] = await api(
    "/rest/v1/canonical_metrics?select=key,origin&order=key.asc"
  )

  const codeMetrics = Object.values(CANONICAL_METRICS)
    .map((m) => `${m.key}:${m.origin}`)
    .sort()
  const databaseMetrics = dbMetrics.map((m) => `${m.key}:${m.origin}`).sort()

  check(
    "the database vocabulary matches the code exactly",
    codeMetrics.join(",") === databaseMetrics.join(","),
    `code ${codeMetrics.length} vs db ${databaseMetrics.length}`
  )

  check(
    "cost of goods is marked as something a source may supply",
    dbMetrics.find((m) => m.key === "cogs")?.origin === "sourced"
  )
  check(
    "net profit is marked as something only BizMind calculates",
    dbMetrics.find((m) => m.key === "net_profit")?.origin === "computed"
  )

  const forgeMetric = await attempt("/rest/v1/canonical_metrics", {
    method: "POST",
    body: JSON.stringify({ key: "invented_profit", origin: "sourced" }),
  })
  check("a tenant cannot add a metric to the vocabulary", !forgeMetric.ok, String(forgeMetric.status))

  /* ---------------------------------------------------------------------- */
  section("2. A SUGGESTION IS NOT A MAPPING")

  const suggested = await rpc("suggest_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_entity: "ORDERS",
    p_field_key: "product_wholesale_price",
    p_source_label: "product Wholesale Price",
    p_candidate_metric: "cogs",
    p_confidence: "medium",
    p_reason: "The heading looks like a product cost.",
    p_ambiguity: "It may be a price charged rather than a cost paid.",
  })

  check("a suggestion is recorded", suggested.field_key === "product_wholesale_price")
  check("it carries the candidate", suggested.candidate_metric === "cogs")
  check("and the reason", (suggested.candidate_reason?.length ?? 0) > 0)
  check("and the warning about what else it could mean", suggested.ambiguity_warning !== null)
  check(
    "IT AUTHORISES NOTHING: maps_to is still empty",
    suggested.maps_to === null,
    String(suggested.maps_to)
  )
  check(
    "and its status is PENDING_CONFIRMATION",
    suggested.status === "PENDING_CONFIRMATION",
    suggested.status
  )

  check(
    "THE RAW COLUMN NAME IS PRESERVED, odd casing and all",
    suggested.source_label === "product Wholesale Price"
  )

  /* ---------------------------------------------------------------------- */
  section("3. THE GATE (from Phase 7.1) STILL HOLDS")

  const forgeMapping = await attempt("/rest/v1/source_field_semantics", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      source: "AMAZON",
      field_key: "sneaky",
      source_label: "Sneaky",
      status: "PENDING_CONFIRMATION",
      maps_to: "cogs",
    }),
  })
  check("an unconfirmed field still cannot be mapped", !forgeMapping.ok)
  check(
    "refused by the same constraint as before",
    forgeMapping.body.includes("semantics_mapping_requires_confirmation"),
    forgeMapping.body.slice(0, 100)
  )

  const forgeConfirm = await attempt("/rest/v1/source_field_semantics", {
    method: "POST",
    body: JSON.stringify({
      business_id: businessId,
      source: "AMAZON",
      field_key: "sneaky2",
      source_label: "Sneaky",
      status: "CONFIRMED",
      maps_to: "cogs",
    }),
  })
  check("a confirmation still cannot be forged without attribution", !forgeConfirm.ok)
  check(
    "refused by the attribution constraint",
    forgeConfirm.body.includes("semantics_confirmation_requires_attribution"),
    forgeConfirm.body.slice(0, 100)
  )

  /* ---------------------------------------------------------------------- */
  section("4. A SOURCE CANNOT CLAIM A CONCLUSION")

  const claimNetProfit = await tryRpc("confirm_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_field_key: "profit_loss",
    p_status: "CONFIRMED",
    p_maps_to: "net_profit",
    p_source_label: "Profit/Loss",
  })
  check("Profit/Loss cannot be confirmed as BizMind net profit", !claimNetProfit.ok)
  check(
    "and the refusal explains why rather than showing a constraint name",
    claimNetProfit.body.includes("calculated by BizMind"),
    claimNetProfit.body.slice(0, 160)
  )

  const claimMargin = await tryRpc("confirm_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_field_key: "margin_col",
    p_status: "CONFIRMED",
    p_maps_to: "gross_margin",
    p_source_label: "Margin %",
  })
  check("nor as gross margin", !claimMargin.ok)

  const claimInvented = await tryRpc("confirm_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_field_key: "invented",
    p_status: "CONFIRMED",
    p_maps_to: "not_a_metric",
    p_source_label: "Whatever",
  })
  check("a metric that does not exist is refused", !claimInvented.ok)

  /* ---------------------------------------------------------------------- */
  section("5. THE REAL AMAZON MAPPING")

  const confirmed = await rpc("confirm_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_field_key: "product_wholesale_price",
    p_status: "CONFIRMED",
    p_maps_to: "cogs",
    p_source_label: "product Wholesale Price",
    p_entity: "ORDERS",
    p_note: "Owner confirmed: the cost of the units sold in the period.",
  })

  check("Product Wholesale Price -> cogs is accepted", confirmed.maps_to === "cogs")
  check("status is CONFIRMED", confirmed.status === "CONFIRMED")
  check("the confirmation carries a person", confirmed.confirmed_by !== null)
  check("and a timestamp", confirmed.confirmed_at !== null)
  check(
    "THE CANDIDATE IS STILL THERE, so it is clear what was guessed and what was decided",
    confirmed.candidate_metric === "cogs" && confirmed.candidate_confidence === "medium"
  )
  check(
    "the source's own column name survived the mapping",
    confirmed.source_label === "product Wholesale Price"
  )

  check(
    "this matches what the repository documents",
    AMAZON_SETTLEMENT.fields.find((f) => f.key === "product_wholesale_price")?.mapsTo ===
      confirmed.maps_to
  )

  const audit = await api(
    `/rest/v1/audit_logs?select=action,after_data&business_id=eq.${businessId}&order=created_at.desc&limit=1`
  )
  check("the confirmation is in the audit log", audit[0]?.action === "source_field_semantics.confirmed")
  check("naming the column and the metric", audit[0]?.after_data?.maps_to === "cogs")

  /* ---------------------------------------------------------------------- */
  section("6. REJECTING, AND SAYING 'I DO NOT KNOW'")

  const rejected = await rpc("confirm_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_field_key: "other",
    p_status: "REJECTED",
    p_source_label: "Other",
    p_note: "Not a cost. Leave it out.",
  })
  check("a suggestion can be rejected", rejected.status === "REJECTED")
  check("a rejected field maps to nothing", rejected.maps_to === null)

  const unsure = await rpc("confirm_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_field_key: "storage_fee",
    p_status: "UNKNOWN",
    p_source_label: "Storage Fee",
  })
  check("'I am not sure' is a real answer the system records", unsure.status === "UNKNOWN")
  check("and it maps to nothing either", unsure.maps_to === null)

  const halfConfirmed = await tryRpc("confirm_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_field_key: "amazon_fees",
    p_status: "CONFIRMED",
    p_source_label: "Amazon fees",
  })
  check("confirming without naming a metric is refused", !halfConfirmed.ok)

  /* ---------------------------------------------------------------------- */
  section("7. A SAVED PROFILE IS REUSED, BUT NEVER BLINDLY")

  const januaryColumns = [
    "Sales",
    "Amazon fees",
    "Payment",
    "product Wholesale Price",
    "Other",
    "Storage Fee",
  ]

  const profile = await rpc("save_mapping_profile", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_entity: "ORDERS",
    p_name: "Amazon.ae monthly settlement",
    p_signature: columnSignature(januaryColumns),
    p_columns: januaryColumns,
    p_field_keys: [
      "sales",
      "amazon_fees",
      "payment",
      "product_wholesale_price",
      "other",
      "storage_fee",
    ],
  })
  check("the profile is saved", profile.name === "Amazon.ae monthly settlement")

  // February: the same export, columns shuffled.
  const februaryColumns = [
    "Payment",
    "product Wholesale Price",
    "Sales",
    "Storage Fee",
    "Amazon fees",
    "Other",
  ]

  const resolved = await rpc("resolve_mapping_profile", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_entity: "ORDERS",
    p_signature: columnSignature(februaryColumns),
  })

  check(
    "the same file is recognised next month despite the column order",
    resolved.length > 0 && resolved[0].profile_name === "Amazon.ae monthly settlement",
    `${resolved.length} fields`
  )

  const wholesaleRow = resolved.find(
    (r: { field_key: string }) => r.field_key === "product_wholesale_price"
  )
  check("the confirmed mapping comes back ready to use", wholesaleRow?.usable === true)
  check("with its metric", wholesaleRow?.maps_to === "cogs")

  const unusable = resolved.filter((r: { usable: boolean }) => !r.usable)
  check(
    "everything not confirmed comes back explicitly UNUSABLE",
    unusable.length === resolved.length - 1,
    `${unusable.length} of ${resolved.length}`
  )
  check(
    "including the one the owner said they were unsure about",
    unusable.some(
      (r: { field_key: string; status: string }) =>
        r.field_key === "storage_fee" && r.status === "UNKNOWN"
    )
  )

  // March: the marketplace adds a column.
  const marchColumns = [...februaryColumns, "Cost of Advertising"]
  const marchResolved = await rpc("resolve_mapping_profile", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_entity: "ORDERS",
    p_signature: columnSignature(marchColumns),
  })

  check(
    "A FILE WITH A NEW COLUMN IS NOT RECOGNISED, so the new column gets asked about",
    marchResolved.length === 0,
    `${marchResolved.length} fields matched`
  )

  /* ---------------------------------------------------------------------- */
  section("8. LINEAGE: WHERE DID THIS NUMBER COME FROM?")

  const lineage = await rpc("mapping_lineage", {
    p_business_id: businessId,
    p_metric: "cogs",
  })

  check("cost of goods has a lineage record", lineage.length === 1, `${lineage.length} rows`)

  const line = lineage[0]
  check("naming the canonical metric", line?.canonical_metric === "cogs")
  check("the source it came from", line?.source === "AMAZON")
  check("THE ORIGINAL COLUMN NAME", line?.source_label === "product Wholesale Price")
  check("the status", line?.status === "CONFIRMED")
  check("who confirmed it", line?.confirmed_by !== null)
  check("when", line?.confirmed_at !== null)
  check("what they said", (line?.note?.length ?? 0) > 0)
  check(
    "and what BizMind had guessed before they answered",
    line?.candidate_metric === "cogs" && line?.candidate_confidence === "medium"
  )

  const fullLineage = await rpc("mapping_lineage", { p_business_id: businessId })
  check(
    "the unmapped columns are in the lineage too, so the gaps are visible",
    fullLineage.length > lineage.length,
    `${fullLineage.length} rows`
  )
  check(
    "and they show no metric rather than a blank one",
    fullLineage
      .filter((r: { status: string }) => r.status !== "CONFIRMED")
      .every((r: { canonical_metric: string | null }) => r.canonical_metric === null)
  )

  /* ---------------------------------------------------------------------- */
  section("9. ANALYTICS IS UNAFFECTED BY ANY OF THIS")

  // Mapping decides what a column MEANS. It must not, by itself, change a
  // single figure -- otherwise confirming something would silently restate
  // last month's profit.
  const [before] = await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: "2020-01-01T00:00:00Z",
    p_to: "2030-01-01T00:00:00Z",
  })

  await rpc("confirm_source_field_semantics", {
    p_business_id: businessId,
    p_source: "AMAZON",
    p_field_key: "sales",
    p_status: "CONFIRMED",
    p_maps_to: "revenue",
    p_source_label: "Sales",
  })

  const [after] = await rpc("analytics_financials", {
    p_business_id: businessId,
    p_from: "2020-01-01T00:00:00Z",
    p_to: "2030-01-01T00:00:00Z",
  })

  check(
    "confirming a mapping moved no figure",
    Number(before.revenue) === Number(after.revenue) &&
      Number(before.cogs) === Number(after.cogs) &&
      Number(before.gross_profit) === Number(after.gross_profit),
    `${before.revenue}/${before.gross_profit} -> ${after.revenue}/${after.gross_profit}`
  )

  /* ---------------------------------------------------------------------- */
  section("10. TENANT ISOLATION")

  // Business B is a different person entirely. Everything below is an attack,
  // and every one of them must fail.

  const readSemantics = await attempt(
    `/rest/v1/source_field_semantics?select=*&business_id=eq.${businessId}`,
    {},
    otherToken
  )
  check(
    "B cannot read A's column meanings",
    readSemantics.ok && JSON.parse(readSemantics.body).length === 0,
    readSemantics.body.slice(0, 80)
  )

  const readProfiles = await attempt(
    `/rest/v1/source_mapping_profiles?select=*&business_id=eq.${businessId}`,
    {},
    otherToken
  )
  check(
    "B cannot read A's mapping profiles",
    readProfiles.ok && JSON.parse(readProfiles.body).length === 0
  )

  const readProfileFields = await attempt(
    `/rest/v1/source_mapping_profile_fields?select=*&business_id=eq.${businessId}`,
    {},
    otherToken
  )
  check(
    "B cannot read which columns A's profile covers",
    readProfileFields.ok && JSON.parse(readProfileFields.body).length === 0
  )

  const bLineage = await tryRpc("mapping_lineage", { p_business_id: businessId }, otherToken)
  check(
    "B cannot read A's lineage even by asking for it directly",
    bLineage.ok && JSON.parse(bLineage.body).length === 0,
    bLineage.body.slice(0, 80)
  )

  const bResolve = await tryRpc(
    "resolve_mapping_profile",
    {
      p_business_id: businessId,
      p_source: "AMAZON",
      p_entity: "ORDERS",
      p_signature: columnSignature(februaryColumns),
    },
    otherToken
  )
  check(
    "B cannot resolve A's profile",
    bResolve.ok && JSON.parse(bResolve.body).length === 0
  )

  const bWrite = await attempt(
    "/rest/v1/source_field_semantics",
    {
      method: "POST",
      body: JSON.stringify({
        business_id: businessId,
        source: "AMAZON",
        field_key: "hostile",
        source_label: "Hostile",
        status: "PENDING_CONFIRMATION",
      }),
    },
    otherToken
  )
  check("B cannot write a column meaning into A's business", !bWrite.ok, String(bWrite.status))

  const bConfirm = await tryRpc(
    "confirm_source_field_semantics",
    {
      p_business_id: businessId,
      p_source: "AMAZON",
      p_field_key: "product_wholesale_price",
      p_status: "REJECTED",
      p_source_label: "product Wholesale Price",
    },
    otherToken
  )
  check("B cannot overturn A's confirmed mapping", !bConfirm.ok, String(bConfirm.status))

  const bProfile = await tryRpc(
    "save_mapping_profile",
    {
      p_business_id: businessId,
      p_source: "AMAZON",
      p_entity: "ORDERS",
      p_name: "Hostile profile",
      p_signature: "x",
      p_columns: ["x"],
      p_field_keys: [],
    },
    otherToken
  )
  check("B cannot save a profile into A's business", !bProfile.ok, String(bProfile.status))

  const anonymous = await fetch(`${SUPABASE_URL}/rest/v1/source_mapping_profiles?select=*`, {
    headers: { apikey: ANON_KEY },
  })
  check("a signed-out visitor sees no mappings at all", anonymous.status === 401)

  // A's mapping must be exactly as it was after all of that.
  const stillThere = await api(
    `/rest/v1/source_field_semantics?select=status,maps_to&business_id=eq.${businessId}&field_key=eq.product_wholesale_price`
  )
  check(
    "and A's confirmed mapping survived every attempt",
    stillThere[0]?.status === "CONFIRMED" && stillThere[0]?.maps_to === "cogs"
  )
} finally {
  section("Cleanup")
  await api(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" })
  await api(`/rest/v1/businesses?id=eq.${otherBusinessId}`, { method: "DELETE" }, otherToken)

  const goneA = await api(`/rest/v1/businesses?select=id&id=eq.${businessId}`)
  const goneB = await api(
    `/rest/v1/businesses?select=id&id=eq.${otherBusinessId}`,
    {},
    otherToken
  )
  check("both throwaway tenants deleted", goneA.length === 0 && goneB.length === 0)
}

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
