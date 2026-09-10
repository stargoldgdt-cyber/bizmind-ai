/**
 * The WooCommerce connector, without a store.
 *
 * Run with:  npm run test:woocommerce
 *
 * Every payload here is shaped as WooCommerce's own documentation describes
 * `wc/v3` responses. Nothing reaches a network: a connector's mapping and its
 * signature verification are pure functions, and pure functions deserve tests
 * that cannot be flaky.
 *
 * The interesting assertions are the NEGATIVE ones. WooCommerce has no cost of
 * goods and no marketplace fee, so the honest result is a set of nulls -- and
 * a connector that quietly filled them with plausible arithmetic would produce
 * a margin that looks right and is not.
 */

process.env.BIZMIND_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")

import { readFileSync } from "node:fs"

import { getConnector, registeredProviders } from "../src/services/integrations"
import { checkSiteUrl } from "../src/services/integrations/connectors/woocommerce/client"
import {
  WOO_HEADERS,
  signWooPayload,
  wooCommerceConnector,
} from "../src/services/integrations/connectors/woocommerce"
import {
  isImportableOrder,
  mapOrder,
  mapProduct,
} from "../src/services/integrations/connectors/woocommerce/mapper"

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

/* -------------------------------------------------------------------------- */
/* A WooCommerce order, shaped as wc/v3 returns one                           */
/* -------------------------------------------------------------------------- */

const ORDER = {
  id: 727,
  number: "727",
  status: "completed",
  currency: "AED",
  date_created: "2026-05-01T13:00:00",
  date_created_gmt: "2026-05-01T09:00:00",
  discount_total: "10.00",
  shipping_total: "25.00",
  total: "285.50",
  total_tax: "13.50",
  billing: {
    first_name: "Amina",
    last_name: "Rahman",
    email: "amina@example.com",
  },
  fee_lines: [{ id: 9, name: "Handling", total: "5.00" }],
  line_items: [
    {
      id: 315,
      name: "Widget Pro",
      product_id: 93,
      quantity: 2,
      sku: "W-2001",
      price: 120,
      subtotal: "240.00",
      total: "230.00",
      total_tax: "13.50",
    },
  ],
}

const PRODUCT = {
  id: 93,
  name: "Widget Pro",
  status: "publish",
  sku: "W-2001",
  price: "120.00",
  regular_price: "130.00",
  description: "<p>A <strong>great</strong> widget.</p>",
  stock_quantity: 14,
  categories: [{ id: 9, name: "Widgets", slug: "widgets" }],
}

/* -------------------------------------------------------------------------- */
section("1. REGISTERED, AND NOT PRETENDING TO BE SOMETHING ELSE")

check("the connector is registered", getConnector("WOOCOMMERCE") !== null)
check("alongside the fixture connector",
  registeredProviders().sort().join(",") === "FIXTURE,WOOCOMMERCE",
  registeredProviders().join(",")
)
check("sales land on the WooCommerce channel", wooCommerceConnector.channelType === "WOOCOMMERCE")
check("it syncs orders and products",
  wooCommerceConnector.resources.join(",") === "ORDERS,PRODUCTS"
)

/* -------------------------------------------------------------------------- */
section("2. THE STORE ADDRESS IS UNTRUSTED INPUT")

check("a normal https store is accepted",
  checkSiteUrl("https://shop.example.com").ok
)
check("and reduced to its ORIGIN, so a pasted admin URL does not become the API root",
  (() => {
    const result = checkSiteUrl("https://shop.example.com/wp-admin/edit.php?post_type=shop_order")
    return result.ok && result.origin === "https://shop.example.com"
  })()
)

// Not a preference. Over plain HTTP the consumer secret and every order
// travel in the clear.
const insecure = checkSiteUrl("http://shop.example.com")
check("PLAIN HTTP IS REFUSED", !insecure.ok)
check("and the refusal explains the risk, not the rule",
  !insecure.ok && insecure.reason.includes("clear")
)

// A connection form that fetches a URL is an SSRF hole unless something stops
// it. 169.254.169.254 is the cloud metadata address.
for (const host of [
  "https://localhost",
  "https://127.0.0.1",
  "https://169.254.169.254",
  "https://10.0.0.5",
  "https://192.168.1.1",
  "https://172.16.0.1",
  "https://db.internal",
  "https://printer.local",
]) {
  check(`${host} is refused -- SSRF`, !checkSiteUrl(host).ok)
}

check("credentials in the address are refused",
  !checkSiteUrl("https://user:pass@shop.example.com").ok
)
check("and so is nonsense", !checkSiteUrl("not a url").ok)

/* -------------------------------------------------------------------------- */
section("3. MAPPING AN ORDER")

const mapped = mapOrder(ORDER)
if (mapped === null) throw new Error("The sample order failed to map.")

check("the store's id becomes the external id", mapped.external_id === "727")
check("the order number is kept", mapped.order_number === "727")
check("completed becomes FULFILLED", mapped.status === "FULFILLED")
check("the currency is the store's", mapped.currency === "AED")

// WooCommerce sends GMT without a zone suffix. Read as local time, every
// order would land in the wrong period for anyone outside UTC.
check("THE GMT TIMESTAMP IS MARKED AS UTC",
  mapped.placed_at === "2026-05-01T09:00:00Z", String(mapped.placed_at)
)

check("the total is carried verbatim, digit for digit", mapped.total === "285.50")
check("tax as the store sent it", mapped.tax_total === "13.50")
check("shipping as the store sent it", mapped.shipping_total === "25.00")
check("discount as the store sent it", mapped.discount_total === "10.00")

// The heart of it.
check(
  "SUBTOTAL IS NULL -- deriving it would be arithmetic on money in TypeScript",
  mapped.subtotal === null
)
check(
  "FEE_TOTAL IS NULL -- WooCommerce has no marketplace fee, and fee_lines are " +
    "seller-defined surcharges nobody has defined",
  mapped.fee_total === null
)

check("the customer's email comes from billing", mapped.customer_email === "amina@example.com")
check("and their name is assembled from both parts", mapped.customer_name === "Amina Rahman")

const items = mapped.items as Record<string, unknown>[]
check("the line item is mapped", items.length === 1)
check("with its SKU", items[0].sku === "W-2001")
check("its quantity", items[0].quantity === "2")
check("and the per-unit price", items[0].unit_price === "120")
check("the line total verbatim", items[0].line_total === "230.00")

check(
  "UNIT_COST IS NULL -- WooCommerce core does not store what a product cost",
  items[0].unit_cost === null
)
check(
  "and the line discount is null rather than subtotal minus total",
  items[0].discount === null
)

/* -------------------------------------------------------------------------- */
section("4. STATUS IS A DECISION PER VALUE, NOT A NAME MATCH")

function statusOf(status: string): unknown {
  return mapOrder({ ...ORDER, status })?.status
}

check("pending stays PENDING", statusOf("pending") === "PENDING")
check("processing becomes CONFIRMED", statusOf("processing") === "CONFIRMED")
check("completed becomes FULFILLED", statusOf("completed") === "FULFILLED")
check("cancelled becomes CANCELLED", statusOf("cancelled") === "CANCELLED")
check("refunded becomes REFUNDED", statusOf("refunded") === "REFUNDED")

// The money has not been taken, so counting it as revenue would inflate a
// figure an owner makes decisions on.
check("ON-HOLD IS PENDING, not confirmed", statusOf("on-hold") === "PENDING")

// A failed payment is not an order waiting to happen. Left pending it would
// sit in the revenue figure forever.
check("FAILED IS CANCELLED, not pending", statusOf("failed") === "CANCELLED")

check("an unknown status falls back to PENDING rather than being invented",
  statusOf("some-plugin-status") === "PENDING"
)

check("a draft checkout is not an order at all",
  !isImportableOrder({ ...ORDER, status: "checkout-draft" })
)
check("nor is a trashed one", !isImportableOrder({ ...ORDER, status: "trash" }))
check("but a real one is", isImportableOrder(ORDER))

/* -------------------------------------------------------------------------- */
section("5. WHAT THE MAPPER REFUSES")

check("an order with no id is skipped", mapOrder({ ...ORDER, id: null }) === null)
check("an order with no date is skipped",
  mapOrder({ ...ORDER, date_created_gmt: null, date_created: null }) === null
)
check("an order with no total is skipped", mapOrder({ ...ORDER, total: "" }) === null)
check("something that is not an object is skipped", mapOrder("nonsense") === null)
check("and so is null", mapOrder(null) === null)

// WooCommerce sends "" for a field it has no value for. Reading that as zero
// would state a fact the store never stated.
check(
  "AN EMPTY MONEY FIELD BECOMES NULL, NOT ZERO",
  mapOrder({ ...ORDER, total_tax: "" })?.tax_total === null
)
check("and a non-numeric one is refused rather than coerced",
  mapOrder({ ...ORDER, shipping_total: "free" })?.shipping_total === null
)

/* -------------------------------------------------------------------------- */
section("6. MAPPING A PRODUCT")

const product = mapProduct(PRODUCT)
if (product === null) throw new Error("The sample product failed to map.")

check("the SKU is the key", product.sku === "W-2001")
check("the name is kept", product.name === "Widget Pro")
check("the first category is used", product.category === "Widgets")
check("the price is verbatim", product.unit_price === "120.00")
check("stock becomes the opening figure", product.opening_stock === "14")
check("UNIT_COST IS NULL here too", product.unit_cost === null)

// Storing markup in a field an owner reads as text would show them tags.
check("the HTML description is left out rather than shown raw",
  product.description === null
)

check("a product without a SKU cannot be keyed, so it is skipped",
  mapProduct({ ...PRODUCT, sku: "" }) === null
)

/* -------------------------------------------------------------------------- */
section("7. WEBHOOK IDENTIFICATION")

const body = JSON.stringify(ORDER)
const secret = "a-secret-bizmind-generated"

function headers(overrides: Record<string, string> = {}) {
  return {
    [WOO_HEADERS.source]: "https://shop.example.com",
    [WOO_HEADERS.topic]: "order.updated",
    [WOO_HEADERS.resource]: "order",
    [WOO_HEADERS.event]: "updated",
    [WOO_HEADERS.deliveryId]: "delivery-4242",
    [WOO_HEADERS.webhookId]: "12",
    [WOO_HEADERS.signature]: signWooPayload(body, secret),
    ...overrides,
  }
}

const identity = wooCommerceConnector.parseWebhook({ headers: headers(), rawBody: body })
check("a delivery is identified", identity.kind === "identified")
check("by the STORE it names, never a tenant",
  identity.kind === "identified" &&
    identity.identity.externalAccountId === "https://shop.example.com"
)
check("WooCommerce's delivery id is the idempotency key",
  identity.kind === "identified" && identity.identity.externalEventId === "delivery-4242"
)

// A trailing slash would otherwise produce a store we have never heard of.
check("the source is normalised to an origin",
  (() => {
    const result = wooCommerceConnector.parseWebhook({
      headers: headers({ [WOO_HEADERS.source]: "https://shop.example.com/" }),
      rawBody: body,
    })
    return result.kind === "identified" &&
      result.identity.externalAccountId === "https://shop.example.com"
  })()
)

check("a delivery with no source is unparseable",
  wooCommerceConnector.parseWebhook({
    headers: headers({ [WOO_HEADERS.source]: "" }), rawBody: body,
  }).kind === "unparseable"
)
check("nor one with no delivery id -- there would be no idempotency key",
  wooCommerceConnector.parseWebhook({
    headers: headers({ [WOO_HEADERS.deliveryId]: "" }), rawBody: body,
  }).kind === "unparseable"
)
check("an http source is refused, matching the connection rule",
  wooCommerceConnector.parseWebhook({
    headers: headers({ [WOO_HEADERS.source]: "http://shop.example.com" }), rawBody: body,
  }).kind === "unparseable"
)

/* -------------------------------------------------------------------------- */
section("8. WEBHOOK VERIFICATION")

check("A VALID SIGNATURE VERIFIES",
  wooCommerceConnector.verifyWebhook({ headers: headers(), rawBody: body, secret })
)
check("AN INVALID ONE DOES NOT",
  !wooCommerceConnector.verifyWebhook({
    headers: headers({ [WOO_HEADERS.signature]: "AAAA" }), rawBody: body, secret,
  })
)
check("a missing signature does not",
  !wooCommerceConnector.verifyWebhook({
    headers: headers({ [WOO_HEADERS.signature]: "" }), rawBody: body, secret,
  })
)
check("the right signature with the WRONG SECRET does not",
  !wooCommerceConnector.verifyWebhook({ headers: headers(), rawBody: body, secret: "other" })
)

// The reason the route must never call request.json() first.
check("A BODY CHANGED BY ONE BYTE FAILS",
  !wooCommerceConnector.verifyWebhook({
    headers: headers(), rawBody: `${body} `, secret,
  })
)
check("and a re-serialised body fails, which is why the RAW bytes are verified",
  !wooCommerceConnector.verifyWebhook({
    headers: headers(), rawBody: JSON.stringify(JSON.parse(body)) + "\n", secret,
  })
)

// WooCommerce defaults the secret to an MD5 of `id|username` when left blank.
// That is guessable, so BizMind always supplies its own.
const source = readFileSync(
  "src/services/integrations/connectors/woocommerce/index.ts",
  "utf8"
)
// Scoped to verifyWebhook itself. The first version of this check scanned the
// whole file and matched `consumer_secret ?? ""` -- a credential default in an
// unrelated function, which is not a fallback secret at all.
const verifyBody = source.slice(
  source.indexOf("verifyWebhook({"),
  source.indexOf("parseWebhookRecords({")
)

check("verifyWebhook uses the secret it was given and never substitutes one",
  !/secret\s*(\|\||\?\?)/.test(verifyBody) && verifyBody.includes("createHmac"),
  verifyBody.slice(0, 80)
)
check("and returns false when no signature was sent, rather than passing",
  /if\s*\(!provided\)\s*return false/.test(verifyBody)
)

/* -------------------------------------------------------------------------- */
section("9. WEBHOOK RECORDS")

check("an order event yields a record",
  wooCommerceConnector.parseWebhookRecords({
    eventType: "order.updated", rawBody: body,
  })?.records.length === 1
)
check("aimed at ORDERS",
  wooCommerceConnector.parseWebhookRecords({
    eventType: "order.created", rawBody: body,
  })?.resource === "ORDERS"
)

// An order removed from WooCommerce is not evidence it never happened, and
// erasing history on a webhook is not a decision to make automatically.
check("A DELETION IS NOT APPLIED",
  wooCommerceConnector.parseWebhookRecords({
    eventType: "order.deleted", rawBody: body,
  }) === null
)
check("a product event is not applied through this path",
  wooCommerceConnector.parseWebhookRecords({
    eventType: "product.updated", rawBody: JSON.stringify(PRODUCT),
  }) === null
)
check("a body that verified but will not parse yields nothing rather than throwing",
  wooCommerceConnector.parseWebhookRecords({ eventType: "order.updated", rawBody: "{{{" }) === null
)

/* -------------------------------------------------------------------------- */
section("10. NO FINANCIAL ARITHMETIC, AND NO RETRYING")

const mapperSource = readFileSync(
  "src/services/integrations/connectors/woocommerce/mapper.ts",
  "utf8"
)
const clientSource = readFileSync(
  "src/services/integrations/connectors/woocommerce/client.ts",
  "utf8"
)

function stripProse(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ")
}

const MONEY_NAME = /(total|subtotal|price|tax|discount|cost|fee)/i

const conversions = [...stripProse(mapperSource).matchAll(/(?<![A-Za-z])Number\(([^)]*)\)/g)]
check("the mapper never converts a money field to a number",
  !conversions.some((m) => MONEY_NAME.test(m[1])),
  conversions.map((m) => m[1]).join(" | ")
)

check("and never adds, subtracts or multiplies one",
  !/\b(total|subtotal|price|tax|discount)\w*\s*[-+*/]\s*[\w(]/.test(stripProse(mapperSource))
)

// A connector that retries has taken a job belonging to the engine -- and
// taken it once per provider.
check("the connector does not retry: it REPORTS a rate limit",
  clientSource.includes("rate_limited") && !/setTimeout\s*\(\s*[^,]*,\s*\d{3,}/.test(stripProse(clientSource))
)
check("and reports a permanent error separately from a retryable one",
  clientSource.includes("permanent_error") && clientSource.includes("retryable_error")
)

// The Authorization header must not follow a redirect to a host the owner
// never named.
check("redirects are not followed", clientSource.includes('redirect: "manual"'))
check("and a redirect is reported rather than chased",
  clientSource.includes("The store redirected the API request")
)

/* -------------------------------------------------------------------------- */
console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))

if (failed > 0) process.exit(1)
