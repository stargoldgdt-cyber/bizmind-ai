/**
 * The integration engine: everything provable without a database.
 *
 * Run with:  npm run test:integration-engine
 *
 * The fixture connector exists so this suite can be exhaustive. Every failure
 * a real provider will eventually inflict -- a rate limit, a 500 that clears,
 * a revoked token, a repeated record, a forged signature -- is produced here
 * on demand, deterministically, with no network and no credentials.
 *
 * No key is read from the environment except a test key set below, and no
 * request leaves this process.
 */

// A throwaway key, set before anything reads it. Not a real credential.
process.env.BIZMIND_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
  isEncryptionConfigured,
  signaturesMatch,
} from "../src/lib/crypto"
import {
  getConnector,
  isKnownProvider,
  registeredProviders,
} from "../src/services/integrations"
import {
  FIXTURE_HEADERS,
  fixtureConnector,
  resetFixtureState,
  signFixturePayload,
} from "../src/services/integrations/connectors/fixture"
import type { ConnectorContext } from "../src/services/integrations/contract"

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

/**
 * Comments and string literals removed.
 *
 * Both of the checks that use this failed on their first run against PROSE:
 * the route's own comment explains why `request.json()` must not be called,
 * and an error message names the encryption key. A scanner that reads
 * documentation as code punishes the act of explaining itself.
 */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ")
}

const BUSINESS_A = "11111111-1111-4111-8111-111111111111"
const BUSINESS_B = "22222222-2222-4222-8222-222222222222"

function context(scenario: string, account = "fixture-store-1"): ConnectorContext {
  return {
    externalAccountId: account,
    credentials: { api_key: "fixture-key" },
    metadata: { scenario },
  }
}

/* -------------------------------------------------------------------------- */
section("1. CREDENTIAL ENCRYPTION")

check("encryption reports itself configured", isEncryptionConfigured())

const secret = "shpat_this_is_a_pretend_access_token"
const sealed = encryptCredential(secret, {
  businessId: BUSINESS_A,
  purpose: "access_token",
})

check("a sealed credential round-trips",
  decryptCredential(sealed, { businessId: BUSINESS_A, purpose: "access_token" }) === secret
)
check("the ciphertext does not contain the plaintext", !sealed.includes(secret))
check("it is versioned, so the scheme can be rotated", sealed.startsWith("v1."))
check("and it is authenticated encryption, so it carries a tag",
  sealed.split(".").length === 4
)

// The attack this defends against is not "read the secret" -- it is "move a
// valid secret to a row where it authorises something else".
function decryptFails(payload: string, businessId: string, purpose: "access_token" | "webhook_secret"): boolean {
  try {
    decryptCredential(payload, { businessId, purpose })
    return false
  } catch (error) {
    return error instanceof CredentialCryptoError
  }
}

check(
  "A CIPHERTEXT CANNOT BE MOVED TO ANOTHER TENANT",
  decryptFails(sealed, BUSINESS_B, "access_token")
)
check(
  "nor decrypted as a different kind of secret",
  decryptFails(sealed, BUSINESS_A, "webhook_secret")
)

const tampered = sealed.slice(0, -4) + "AAAA"
check("a tampered ciphertext is refused, not silently mangled",
  decryptFails(tampered, BUSINESS_A, "access_token")
)
check("so is a payload in an unknown format",
  decryptFails("not-a-credential", BUSINESS_A, "access_token")
)

check(
  "the failure message never contains the plaintext",
  (() => {
    try {
      decryptCredential(sealed, { businessId: BUSINESS_B, purpose: "access_token" })
      return false
    } catch (error) {
      return error instanceof Error && !error.message.includes(secret)
    }
  })()
)

check("two encryptions of the same value differ (random nonce)",
  encryptCredential(secret, { businessId: BUSINESS_A, purpose: "access_token" }) !==
    encryptCredential(secret, { businessId: BUSINESS_A, purpose: "access_token" })
)

check("an empty credential is refused rather than stored", (() => {
  try {
    encryptCredential("", { businessId: BUSINESS_A, purpose: "access_token" })
    return false
  } catch {
    return true
  }
})())

/* -------------------------------------------------------------------------- */
section("2. SIGNATURE COMPARISON")

check("identical signatures match", signaturesMatch("abc123", "abc123"))
check("different signatures do not", !signaturesMatch("abc123", "abc124"))
check("a shorter signature does not match", !signaturesMatch("abc123", "abc12"))
check("nor a longer one", !signaturesMatch("abc123", "abc1234"))
check("an empty provided signature does not match", !signaturesMatch("abc123", ""))

/* -------------------------------------------------------------------------- */
section("3. THE REGISTRY")

check("the fixture connector is registered", getConnector("FIXTURE") !== null)
check("an unknown provider resolves to nothing", getConnector("MAGENTO") === null)
check("and is not recognised as a provider", !isKnownProvider("MAGENTO"))
check("the real providers are recognised even before they are built",
  isKnownProvider("SHOPIFY") && isKnownProvider("WOOCOMMERCE")
)
// This said "only the fixture connector ships today" until WooCommerce
// landed, then named those two until Google Sheets landed. The meaningful
// guarantee is unchanged: SHOPIFY is not registered, because a connector that
// appears in the registry before it exists is one an owner could try to
// connect to nothing.
check("the fixture, WooCommerce and Google Sheets connectors ship -- and nothing else",
  registeredProviders().sort().join(",") === "FIXTURE,GOOGLE_SHEETS,WOOCOMMERCE",
  registeredProviders().join(",")
)
check("SHOPIFY IS NOT REGISTERED -- it is not built yet",
  getConnector("SHOPIFY") === null
)
check("but the engine already recognises the name, so a job for it fails cleanly",
  isKnownProvider("SHOPIFY")
)
check("the fixture connector does not claim a production channel type",
  fixtureConnector.channelType === "OTHER"
)

/* -------------------------------------------------------------------------- */
section("4. PAGINATION AND CURSOR PROGRESSION")

resetFixtureState()

const page1 = await fixtureConnector.fetchPage({
  context: context("happy"), resource: "ORDERS", mode: "INITIAL", cursor: null,
})

check("the first page returns records", page1.kind === "page" && page1.records.length === 2)
check("and a cursor", page1.kind === "page" && page1.nextCursor === "page-1")
check("and says there is more", page1.kind === "page" && page1.hasMore)

const page2 = await fixtureConnector.fetchPage({
  context: context("happy"), resource: "ORDERS", mode: "INITIAL",
  cursor: page1.kind === "page" ? page1.nextCursor : null,
})
check("the cursor advances to a different page",
  page2.kind === "page" &&
    page2.records[0]?.external_id === "FIX-3",
  page2.kind === "page" ? String(page2.records[0]?.external_id) : page2.kind
)

const page3 = await fixtureConnector.fetchPage({
  context: context("happy"), resource: "ORDERS", mode: "INITIAL", cursor: "page-2",
})
check("the last page says there is no more", page3.kind === "page" && !page3.hasMore)

const past = await fixtureConnector.fetchPage({
  context: context("happy"), resource: "ORDERS", mode: "INITIAL", cursor: "page-9",
})
check("reading past the end returns nothing rather than looping",
  past.kind === "page" && past.records.length === 0 && !past.hasMore
)

/* -------------------------------------------------------------------------- */
section("5. THE FAILURES A REAL PROVIDER WILL PRODUCE")

resetFixtureState()
const limited = await fixtureConnector.fetchPage({
  context: context("rate_limited_once"), resource: "ORDERS", mode: "INITIAL", cursor: null,
})
check("a rate limit is reported as its own kind, not as an error",
  limited.kind === "rate_limited", limited.kind
)
check("and carries how long to wait",
  limited.kind === "rate_limited" && limited.retryAfterMs === 1000
)

const afterLimit = await fixtureConnector.fetchPage({
  context: context("rate_limited_once"), resource: "ORDERS", mode: "INITIAL", cursor: null,
})
check("THE SECOND ATTEMPT SUCCEEDS -- the engine can recover, not just give up",
  afterLimit.kind === "page", afterLimit.kind
)

resetFixtureState()
const transient = await fixtureConnector.fetchPage({
  context: context("transient_error_once"), resource: "ORDERS", mode: "INITIAL", cursor: null,
})
check("a 500 is retryable", transient.kind === "retryable_error", transient.kind)

const afterTransient = await fixtureConnector.fetchPage({
  context: context("transient_error_once"), resource: "ORDERS", mode: "INITIAL", cursor: null,
})
check("and clears on the next attempt", afterTransient.kind === "page")

resetFixtureState()
const permanent = await fixtureConnector.fetchPage({
  context: context("permanent_error"), resource: "ORDERS", mode: "INITIAL", cursor: null,
})
check("A REVOKED TOKEN IS PERMANENT, so the engine need not burn seven attempts",
  permanent.kind === "permanent_error", permanent.kind
)

const permanentAgain = await fixtureConnector.fetchPage({
  context: context("permanent_error"), resource: "ORDERS", mode: "INITIAL", cursor: null,
})
check("and stays permanent", permanentAgain.kind === "permanent_error")

/* -------------------------------------------------------------------------- */
section("6. DUPLICATES AND PARTIAL PAGES")

resetFixtureState()
const dupes = await fixtureConnector.fetchPage({
  context: context("duplicates"), resource: "ORDERS", mode: "INITIAL", cursor: "page-1",
})

check(
  "a provider can repeat a record within a page -- ordinary, not exotic",
  dupes.kind === "page" &&
    dupes.records.filter((r) => r.external_id === dupes.records[0]?.external_id).length === 2
)

resetFixtureState()
const partial = await fixtureConnector.fetchPage({
  context: context("partial"), resource: "ORDERS", mode: "INITIAL", cursor: "page-1",
})
check("a page can carry one unusable row among good ones",
  partial.kind === "page" &&
    partial.records.some((r) => String(r.external_id).includes("MALFORMED")) &&
    partial.records.some((r) => !String(r.external_id).includes("MALFORMED"))
)

/* -------------------------------------------------------------------------- */
section("7. WEBHOOK IDENTIFICATION AND VERIFICATION")

const body = JSON.stringify({ external_id: "FIX-1", total: "100.0000" })
const webhookSecret = "fixture-webhook-secret"

function headersFor(overrides: Record<string, string> = {}) {
  return {
    [FIXTURE_HEADERS.account]: "fixture-store-1",
    [FIXTURE_HEADERS.delivery]: "delivery-1",
    [FIXTURE_HEADERS.topic]: "orders/create",
    [FIXTURE_HEADERS.signature]: signFixturePayload(body, webhookSecret),
    ...overrides,
  }
}

const identified = fixtureConnector.parseWebhook({ headers: headersFor(), rawBody: body })
check("a well-formed delivery is identified", identified.kind === "identified")
check("it names the STORE, never a tenant",
  identified.kind === "identified" &&
    identified.identity.externalAccountId === "fixture-store-1"
)
check("and carries the provider's delivery id as the idempotency key",
  identified.kind === "identified" && identified.identity.externalEventId === "delivery-1"
)

const missingAccount = fixtureConnector.parseWebhook({
  headers: headersFor({ [FIXTURE_HEADERS.account]: "" }), rawBody: body,
})
check("a delivery with no store is unparseable, so nothing is looked up",
  missingAccount.kind === "unparseable"
)

const missingDelivery = fixtureConnector.parseWebhook({
  headers: headersFor({ [FIXTURE_HEADERS.delivery]: "" }), rawBody: body,
})
check("nor one with no delivery id -- there would be no idempotency key",
  missingDelivery.kind === "unparseable"
)

check("A VALID SIGNATURE VERIFIES",
  fixtureConnector.verifyWebhook({ headers: headersFor(), rawBody: body, secret: webhookSecret })
)
check("AN INVALID SIGNATURE DOES NOT",
  !fixtureConnector.verifyWebhook({
    headers: headersFor({ [FIXTURE_HEADERS.signature]: "AAAA" }),
    rawBody: body,
    secret: webhookSecret,
  })
)
check("a missing signature does not",
  !fixtureConnector.verifyWebhook({
    headers: headersFor({ [FIXTURE_HEADERS.signature]: "" }),
    rawBody: body,
    secret: webhookSecret,
  })
)
check("the right signature with the WRONG SECRET does not",
  !fixtureConnector.verifyWebhook({ headers: headersFor(), rawBody: body, secret: "other-secret" })
)

// The bug that looks exactly like an attack, and costs a day to find.
const reserialised = JSON.stringify(JSON.parse(body.replace('"external_id"', '"external_id"')))
check(
  "A BODY CHANGED BY ONE BYTE FAILS -- which is why the raw bytes must be verified",
  !fixtureConnector.verifyWebhook({
    headers: headersFor(), rawBody: body + " ", secret: webhookSecret,
  }) && reserialised.length > 0
)

/* -------------------------------------------------------------------------- */
section("8. WEBHOOK RECORD EXTRACTION")

const extracted = fixtureConnector.parseWebhookRecords({
  eventType: "orders/create", rawBody: body,
})
check("an order event yields records for the ingestion pipeline",
  extracted !== null && extracted.records.length === 1
)
check("aimed at the right resource", extracted?.resource === "ORDERS")

check("an event type we do not act on yields nothing, and that is not an error",
  fixtureConnector.parseWebhookRecords({ eventType: "app/uninstalled", rawBody: body }) === null
)
check("a body that verified but will not parse yields nothing rather than throwing",
  fixtureConnector.parseWebhookRecords({ eventType: "orders/create", rawBody: "{{{" }) === null
)

/* -------------------------------------------------------------------------- */
section("9. THE PRIVILEGED DOOR IS NARROW")

const privileged = readFileSync("src/services/integrations/security/privileged.ts", "utf8")

check("the privileged client is never exported",
  !/export\s+(async\s+)?function\s+privilegedClient/.test(privileged) &&
    !/export\s+const\s+privilegedClient/.test(privileged)
)
check("only an allowlist of tenant-resolving functions is reachable",
  privileged.includes("TRUSTED_FUNCTIONS") && privileged.includes("is not a trusted integration function")
)
check("A BUSINESS ID CANNOT BE PASSED THROUGH IT",
  privileged.includes('"p_business_id" in args')
)

/* -------------------------------------------------------------------------- */
section("10. SECRETS DO NOT LEAK")

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full)
  }
  return out
}

const sourceFiles = walk("src")
const normalised = (file: string) => file.replace(/\\/g, "/")

const serviceRoleFiles = sourceFiles.filter((file) =>
  readFileSync(file, "utf8").includes("SUPABASE_SERVICE_ROLE_KEY")
)

check(
  "the service-role key appears in exactly two confined modules",
  serviceRoleFiles.length === 2,
  serviceRoleFiles.map(normalised).join(", ")
)
check(
  "and both are inside the integration security layer",
  serviceRoleFiles.every((file) =>
    normalised(file).startsWith("src/services/integrations/security/")
  ),
  serviceRoleFiles.map(normalised).join(", ")
)

// `process.env.` specifically: naming the variable in an error message is
// helping the reader, not reading the key.
const encryptionKeyFiles = sourceFiles.filter((file) =>
  stripNoise(readFileSync(file, "utf8")).includes("process.env.BIZMIND_ENCRYPTION_KEY")
)
check("the encryption key is read in exactly one file",
  encryptionKeyFiles.length === 1 &&
    normalised(encryptionKeyFiles[0]) === "src/lib/crypto.ts",
  encryptionKeyFiles.map(normalised).join(", ")
)

check("no NEXT_PUBLIC_ variable carries a service key or a secret",
  !sourceFiles.some((file) =>
    /NEXT_PUBLIC_[A-Z_]*(SERVICE|SECRET|TOKEN|ENCRYPTION)/.test(readFileSync(file, "utf8"))
  )
)

// A log line is forever, and a token in one is a token in a log aggregator.
const loggers = sourceFiles.filter((file) => {
  const contents = readFileSync(file, "utf8")
  return /console\.(log|error|warn|info)\([^)]*\b(secret|token|credential|apiKey|api_key|password|authorization)\b/i.test(
    contents
  )
})
check("nothing logs a secret, a token or a credential", loggers.length === 0,
  loggers.map(normalised).join(", ")
)

const clientComponents = sourceFiles.filter((file) => {
  const contents = readFileSync(file, "utf8")
  return (
    contents.includes('"use client"') &&
    /credentials_encrypted|webhook_secret_encrypted|SERVICE_ROLE|BIZMIND_ENCRYPTION_KEY/.test(contents)
  )
})
check("no client component references a credential column or a key",
  clientComponents.length === 0, clientComponents.map(normalised).join(", ")
)

for (const file of [
  "src/lib/crypto.ts",
  "src/services/integrations/security/privileged.ts",
  "src/services/integrations/security/store-secrets.ts",
  "src/services/integrations/sync/worker.ts",
  "src/services/integrations/webhooks/receive.ts",
]) {
  check(`${normalised(file)} is server-only`,
    readFileSync(file, "utf8").includes('import "server-only"')
  )
}

/* -------------------------------------------------------------------------- */
section("11. THE ROUTE AND THE PROXY")

const route = readFileSync("src/app/api/v1/webhooks/[provider]/route.ts", "utf8")

check("THE WEBHOOK ROUTE READS THE RAW BODY",
  route.includes("request.text()")
)
check("and never parses it first",
  !stripNoise(route).includes("request.json()")
)
check("and the comment says why, so the next person does not undo it",
  route.includes("re-serialising")
)
check("it runs on the Node runtime, where crypto is available",
  route.includes('runtime = "nodejs"')
)
check("it returns a status without describing what it found",
  !route.includes("outcome.reason")
)

const proxy = readFileSync("src/proxy.ts", "utf8")
check("THE PROXY EXCLUDES WEBHOOK ROUTES from session enforcement",
  proxy.includes("api/v1/webhooks")
)
check("and the exclusion explains that this is not the same as being public",
  /not.*public|signature/i.test(proxy)
)

/* -------------------------------------------------------------------------- */
section("12. NO FINANCIAL ARITHMETIC ENTERED THE CONNECTOR LAYER")

const integrationFiles = sourceFiles.filter((file) =>
  normalised(file).startsWith("src/services/integrations/")
)

const MONEY = /(revenue|gross_profit|net_profit|cogs|fees|margin|unit_cost|line_total)/i

const arithmetic = integrationFiles.filter((file) => {
  const contents = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
  return [...contents.matchAll(/(?<![A-Za-z])Number\(([^)]*)\)/g)].some((m) =>
    MONEY.test(m[1])
  )
})

check("no connector or engine file converts a money value to a number",
  arithmetic.length === 0, arithmetic.map(normalised).join(", ")
)

check("and none of them imports the analytics service",
  !integrationFiles.some((file) =>
    readFileSync(file, "utf8").includes("services/analytics")
  )
)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
