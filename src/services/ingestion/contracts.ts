/**
 * The ingestion contract.
 *
 * Every source of business data — a spreadsheet today, Shopify and WooCommerce
 * later — produces raw records and a mapping onto these canonical fields.
 * Everything downstream (validation, normalisation, the atomic write) is
 * shared, so adding a connector never means touching the universal data model.
 *
 *   Source ──► RawRecord[] ──► Mapping ──► validate ──► normalise ──► apply
 *                                 ▲
 *                    file: chosen by the user
 *                  Shopify: fixed by the connector
 *
 * That is the ONLY difference between a file import and an API integration.
 */

/** One record exactly as the source produced it. Keys are source column names. */
export type RawRecord = Record<string, unknown>

export type EntityKey = "ORDERS" | "PRODUCTS" | "EXPENSES"

/**
 * How much a field matters.
 *
 * `required`     — the import cannot proceed without it.
 * `recommended`  — the import can proceed, but a business figure becomes
 *                  unreliable. The user must acknowledge this explicitly;
 *                  it is never assumed on their behalf.
 * `optional`     — nice to have.
 */
export type FieldImportance = "required" | "recommended" | "optional"

export type FieldType = "text" | "number" | "money" | "date" | "enum"

/** For orders, whether a column describes the order or one line of it. */
export type FieldScope = "order" | "line"

export type FieldDef = {
  key: string
  label: string
  importance: FieldImportance
  type: FieldType
  scope?: FieldScope
  /** What the field is, in the owner's language. */
  help?: string
  /** What breaks without it. Shown when a recommended field is unmapped. */
  consequence?: string
  /** Header names matched case- and punctuation-insensitively. */
  aliases: string[]
  allowNegative?: boolean
  enumValues?: readonly string[]
}

export type EntityDef = {
  key: EntityKey
  label: string
  description: string
  /** What this data unlocks on the dashboard. */
  unlocks: string[]
  fields: FieldDef[]
}

/** Canonical field key → source column name. Unmapped fields are absent. */
export type Mapping = Record<string, string>

/**
 * Choices the user must make explicitly rather than have guessed.
 *
 * Both defaults exist only to prefill the form; an ambiguous value is still
 * rejected rather than resolved silently.
 */
export type ImportOptions = {
  /** Never inferred when values are ambiguous — 03/04 could be either. */
  dateFormat: "auto" | "DMY" | "MDY" | "YMD"
  /** "1.234,56" and "1,234.56" are the same number written two ways. */
  decimalSeparator: "." | ","
  /** The channel this file represents. Part of the idempotency key. */
  source: string
  channelId?: string | null
  /** Set once the user has seen and accepted the recommended-field warnings. */
  acknowledgedWarnings?: boolean
}

export type IssueSeverity = "ERROR" | "WARNING"

export type RowIssue = {
  rowNumber: number
  severity: IssueSeverity
  field?: string
  message: string
  rawValue?: string
}

/** A validated, normalised order ready for the atomic write. */
export type NormalizedOrder = {
  external_id: string
  order_number?: string | null
  placed_at: string
  status?: string | null
  currency: string
  subtotal?: string
  discount_total?: string
  tax_total?: string
  shipping_total?: string
  fee_total?: string
  total: string
  customer_email?: string | null
  customer_name?: string | null
  items: NormalizedOrderItem[]
}

export type NormalizedOrderItem = {
  sku?: string | null
  name?: string | null
  quantity: string
  unit_price?: string
  unit_cost?: string | null
  discount?: string
  tax?: string
  line_total?: string
}

export type NormalizedProduct = {
  sku: string
  name: string
  description?: string | null
  category?: string | null
  brand?: string | null
  barcode?: string | null
  unit_price?: string | null
  unit_cost?: string | null
  opening_stock?: string | null
  reorder_point?: string | null
}

export type NormalizedExpense = {
  incurred_at: string
  amount: string
  currency: string
  category?: string | null
  description?: string | null
  vendor?: string | null
  external_id?: string | null
}

export type NormalizedRow = NormalizedOrder | NormalizedProduct | NormalizedExpense

/**
 * The outcome of validating a whole file. Produced without writing anything,
 * so the user can see exactly what would happen before it does.
 */
export type ValidationResult = {
  rows: NormalizedRow[]
  issues: RowIssue[]
  /** Source rows that produced at least one blocking error. */
  failedRowCount: number
  /** Source rows that will be written. */
  validRowCount: number
  /** Recommended fields the user left unmapped, with their consequences. */
  missingRecommended: { field: string; label: string; consequence: string }[]
  /** True when nothing can be written at all. */
  blocked: boolean
  blockedReason?: string
}
