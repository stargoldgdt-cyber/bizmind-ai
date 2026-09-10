import type { RawRecord } from "@/services/ingestion/contracts"

/**
 * WooCommerce records into BizMind's universal shape.
 *
 * WHAT THIS FILE REFUSES TO DO
 * ---------------------------
 * It does not compute anything. Not a subtotal, not a fee, not a discount --
 * even where the arithmetic is obvious and the fields are right there. Every
 * financial figure in BizMind is calculated in SQL, in exact decimal
 * (MONEY.md), and a connector is nowhere near SQL.
 *
 * That has a visible consequence: several BizMind fields are left NULL where
 * a plausible number could have been assembled. NULL means "the source did not
 * say", which is a different fact from zero and is treated as one throughout
 * the product. The coverage figures on the dashboard already tell an owner
 * exactly which figures are incomplete, so an honest gap is visible rather
 * than papered over with a guess.
 *
 * WHAT WOOCOMMERCE SIMPLY DOES NOT HAVE
 * -------------------------------------
 * **Cost of goods.** WooCommerce core stores no purchase cost, so
 * `unit_cost` is always null. Gross profit and margin will therefore be
 * OVERSTATED for these orders until costs are supplied another way -- by CSV
 * import, or by a costing plugin we do not read. This is the single most
 * important thing to tell a WooCommerce merchant, and the existing cost
 * coverage figure says it on every relevant screen.
 *
 * **Marketplace fees.** There is no marketplace here; the merchant owns the
 * store. `fee_lines` exists but holds seller-defined surcharges whose meaning
 * is not established -- Phase 7.2's rule applies: a field is not a fee because
 * it is called one. Left null, so fee coverage reports the gap.
 */

/* -------------------------------------------------------------------------- */
/* Reading someone else's JSON                                                */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed === "" ? null : trimmed
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

/**
 * A money field, passed through as the exact characters the store sent.
 *
 * WooCommerce sends money as a decimal STRING ("12.50"). It is carried
 * verbatim: parsing it into a JavaScript number and printing it again would
 * introduce the very floating-point conversion migration 0011 removed from
 * the rest of the product.
 *
 * An empty string becomes null, not "0". WooCommerce sends "" for a field it
 * has no value for, and reading that as zero would state a fact the store
 * never stated.
 */
function money(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "") return null
    return /^-?\d+(\.\d+)?$/.test(trimmed) ? trimmed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

/**
 * WooCommerce's GMT timestamps carry no zone suffix -- "2026-05-01T10:00:00".
 * Read as-is they would be interpreted in the server's local time and every
 * order would land in the wrong period for anyone outside UTC.
 */
function gmt(value: unknown): string | null {
  const raw = text(value)
  if (raw === null) return null
  return /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * WooCommerce status to BizMind status.
 *
 * A DECISION PER STATUS, not a name match. Two are worth stating:
 *
 * `on-hold` is PENDING rather than CONFIRMED: the money has not been taken,
 * so counting it as revenue would inflate a figure an owner makes decisions
 * on.
 *
 * `failed` is CANCELLED rather than PENDING: a failed payment is not an order
 * waiting to happen, and leaving it pending would quietly hold it in the
 * revenue figure forever.
 *
 * Both CANCELLED and REFUNDED are excluded from revenue by
 * `analytics_counted_orders()`, which is why getting them right matters.
 */
const STATUS: Record<string, string> = {
  pending: "PENDING",
  "on-hold": "PENDING",
  processing: "CONFIRMED",
  completed: "FULFILLED",
  cancelled: "CANCELLED",
  failed: "CANCELLED",
  refunded: "REFUNDED",
}

/** Orders that are not orders yet. Skipped rather than imported as anything. */
const NOT_AN_ORDER = new Set(["checkout-draft", "trash", "auto-draft"])

export function isImportableOrder(order: unknown): boolean {
  const record = asObject(order)
  if (record === null) return false

  const status = text(record.status)
  if (status === null) return false

  return !NOT_AN_ORDER.has(status)
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

export function mapOrder(order: unknown): RawRecord | null {
  const record = asObject(order)
  if (record === null) return null

  const externalId = text(record.id)
  const placedAt = gmt(record.date_created_gmt ?? record.date_created)
  const total = money(record.total)

  // The three fields the pipeline requires. A record missing any of them
  // cannot be written, and guessing at one is worse than skipping the row --
  // the engine records it as skipped and the owner can see the count.
  if (externalId === null || placedAt === null || total === null) return null

  const billing = asObject(record.billing) ?? {}
  const firstName = text(billing.first_name) ?? ""
  const lastName = text(billing.last_name) ?? ""
  const fullName = `${firstName} ${lastName}`.trim()

  return {
    external_id: externalId,
    order_number: text(record.number),
    placed_at: placedAt,
    status: STATUS[text(record.status) ?? ""] ?? "PENDING",
    currency: text(record.currency) ?? "USD",

    total,

    // NOT COMPUTED. WooCommerce has no order-level subtotal field, and
    // deriving one from total minus tax minus shipping plus discount would be
    // arithmetic on money in TypeScript. Unknown is the truthful answer.
    subtotal: null,

    discount_total: money(record.discount_total),
    tax_total: money(record.total_tax),
    shipping_total: money(record.shipping_total),

    // NOT MAPPED. See the header: WooCommerce core has no marketplace fee,
    // and `fee_lines` holds seller-defined surcharges whose meaning nobody
    // has established. Null means unknown, and fee coverage reports it.
    fee_total: null,

    customer_email: text(billing.email),
    customer_name: fullName === "" ? null : fullName,

    items: asArray(record.line_items)
      .map(mapLineItem)
      .filter((item): item is RawRecord => item !== null),
  }
}

function mapLineItem(item: unknown): RawRecord | null {
  const record = asObject(item)
  if (record === null) return null

  const quantity = text(record.quantity)
  if (quantity === null) return null

  return {
    sku: text(record.sku),
    name: text(record.name),
    quantity,

    // Woo's `price` is the per-unit amount. `subtotal` and `total` are line
    // amounts, and the difference between them is the line discount -- which
    // is a subtraction, so it is left unknown rather than computed here.
    unit_price: money(record.price),
    discount: null,

    // WooCommerce core does not store what a product COST. This is the field
    // that decides whether gross profit is real, and it is null for every
    // WooCommerce order. See the header.
    unit_cost: null,

    tax: money(record.total_tax),
    line_total: money(record.total),
  }
}

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A product, keyed by SKU.
 *
 * `import_apply_products()` identifies a product by its SKU, so a WooCommerce
 * product without one cannot be written. That is common in small stores and it
 * is not an error: the row is skipped and counted.
 */
export function mapProduct(product: unknown): RawRecord | null {
  const record = asObject(product)
  if (record === null) return null

  const sku = text(record.sku)
  const name = text(record.name)
  if (sku === null || name === null) return null

  const categories = asArray(record.categories)
  const firstCategory = asObject(categories[0])

  return {
    sku,
    name,

    // WooCommerce descriptions are HTML. Storing markup in a field an owner
    // reads as text would show them tags, so it is left out until there is a
    // reason to render it properly.
    description: null,

    category: firstCategory ? text(firstCategory.name) : null,
    brand: null,
    barcode: null,

    unit_price: money(record.price) ?? money(record.regular_price),

    // Again: WooCommerce core has no cost of goods. A product row that
    // invented one would be worse than a product row without one, because the
    // catalogue is where a wrong cost would look most authoritative.
    unit_cost: null,

    opening_stock: text(record.stock_quantity),
    reorder_point: null,
  }
}

/** Products that are not sellable items. */
export function isImportableProduct(product: unknown): boolean {
  const record = asObject(product)
  if (record === null) return false

  const status = text(record.status)
  return status !== "trash" && status !== "auto-draft"
}
