import type {
  DetectResult,
  FormatDescriptor,
  LedgerCategory,
  LedgerSide,
  MarketplaceAdapter,
  MappingRuleSummary,
  NormalizeInput,
  NormalizeResult,
  PayoutDraft,
  SettlementDraft,
  TransactionDraft,
} from "../contract"
import { UNMAPPED } from "../contract"
import type { RowIssue } from "@/services/ingestion/contracts"

/**
 * Amazon settlement report, Flat File V2 (GCC Phase 2).
 *
 * `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`: the one Amazon settlement
 * format that is not deprecated (decision A16). Built against four real
 * Amazon.ae settlements (18 Jun – 13 Aug 2026) supplied by the owner. See
 * AMAZON.md for what they showed.
 *
 * WHAT THE REAL FILES TAUGHT, AND THIS CODE RELIES ON
 * ---------------------------------------------------
 *   - One settlement per file. Its FIRST row has no `amount`: it carries the
 *     settlement id, period, deposit date, total and currency. Every other row
 *     is one amount, with `currency` left blank.
 *   - Dates read `02.07.2026 18:27:57 UTC` on Amazon.ae, not the documented
 *     `2026-07-02 18:27:57 UTC`. Both are accepted; nothing else is guessed.
 *   - Amounts use a dot and a leading minus. Anything else is refused as a row
 *     issue rather than reinterpreted.
 *   - Refund lines never carry a quantity. A refunded unit is one Principal
 *     refund line (the rule's COUNT_LINE), always marked as derived.
 *
 * PURE. Rows in, drafts out. It never writes, never converts a currency, and
 * never does arithmetic on money: a sign change is a text operation.
 */

export const AMAZON_V2_FORMAT_ID = "amazon.settlement.flat_file_v2"
export const AMAZON_V2_ADAPTER_VERSION = "1.0.0"

export const AMAZON_V2_HEADERS = [
  "settlement-id",
  "settlement-start-date",
  "settlement-end-date",
  "deposit-date",
  "total-amount",
  "currency",
  "transaction-type",
  "order-id",
  "merchant-order-id",
  "adjustment-id",
  "shipment-id",
  "marketplace-name",
  "amount-type",
  "amount-description",
  "amount",
  "fulfillment-id",
  "posted-date",
  "posted-date-time",
  "order-item-code",
  "merchant-order-item-id",
  "merchant-adjustment-item-id",
  "sku",
  "quantity-purchased",
  "promotion-id",
] as const

export const amazonFlatFileV2Format: FormatDescriptor = {
  id: AMAZON_V2_FORMAT_ID,
  label: "Amazon settlement report (Flat File V2)",
  adapterVersion: AMAZON_V2_ADAPTER_VERSION,
  requiredHeaders: AMAZON_V2_HEADERS,
  // Every column of the report. None carries customer data (verified on the
  // real files); anything outside this list is dropped before storage.
  allowedColumns: AMAZON_V2_HEADERS,
}

export function amazonMatchKey(transactionType: string, amountType: string, amountDescription: string): string {
  return `${transactionType}|${amountType}|${amountDescription}`
}

/**
 * The owner-approved classification (2026-09-15), seeded into
 * `ledger_mapping_rules` by migration 0031. A test fails if the two differ.
 */
export type AmazonRule = {
  matchKey: string
  side: LedgerSide
  category: LedgerCategory
  subcategory: string
  quantityRule: "NONE" | "REPORTED" | "COUNT_LINE"
  attribution: "ORDER_LINE" | "MARKETPLACE"
  note: string
}

export const AMAZON_V2_RULES: readonly AmazonRule[] = [
  { matchKey: "Order|ItemPrice|Principal", side: "PNL", category: "REVENUE", subcategory: "principal", quantityRule: "REPORTED", attribution: "ORDER_LINE", note: "Product sales. Carries the units sold." },
  { matchKey: "Order|ItemPrice|Shipping", side: "PNL", category: "REVENUE", subcategory: "shipping_charged", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Shipping charged to the buyer. Part of gross with Principal." },
  { matchKey: "Order|ItemPrice|COD", side: "PNL", category: "OTHER_INCOME", subcategory: "cod_charge", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Cash-on-delivery charge collected. Owner decision: other income, not sales; offset by the COD fee." },
  { matchKey: "Order|ItemFees|CODFee", side: "PNL", category: "MARKETPLACE_FEE", subcategory: "cod", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Cash-on-delivery fee." },
  { matchKey: "Order|ItemFees|Commission", side: "PNL", category: "MARKETPLACE_FEE", subcategory: "referral", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Referral commission." },
  { matchKey: "Order|ItemFees|FBAPerUnitFulfillmentFee", side: "PNL", category: "FULFILMENT", subcategory: "fba_per_unit", quantityRule: "NONE", attribution: "ORDER_LINE", note: "FBA fulfilment fee per unit." },
  { matchKey: "Order|ItemFees|ShippingChargeback", side: "PNL", category: "FULFILMENT", subcategory: "shipping_chargeback", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Shipping cost charged back to the seller." },
  { matchKey: "Order|ItemFees|VariableClosingFee", side: "PNL", category: "MARKETPLACE_FEE", subcategory: "closing", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Variable closing fee." },
  { matchKey: "Order|Promotion|Shipping", side: "PNL", category: "PROMOTION", subcategory: "shipping", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Shipping promotion." },
  { matchKey: "Refund|ItemPrice|Principal", side: "PNL", category: "REFUND", subcategory: "principal", quantityRule: "COUNT_LINE", attribution: "ORDER_LINE", note: "Refunded sales. Refund lines carry no quantity; each line counts as one refunded unit (derived)." },
  { matchKey: "Refund|ItemPrice|Shipping", side: "PNL", category: "REFUND", subcategory: "shipping_charged", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Refunded shipping charge." },
  { matchKey: "Refund|ItemPrice|COD", side: "PNL", category: "OTHER_INCOME", subcategory: "cod_charge", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Refunded cash-on-delivery charge." },
  { matchKey: "Refund|ItemFees|CODFee", side: "PNL", category: "MARKETPLACE_FEE", subcategory: "cod", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Cash-on-delivery fee returned on a refund." },
  { matchKey: "Refund|ItemFees|Commission", side: "PNL", category: "MARKETPLACE_FEE", subcategory: "referral", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Referral commission returned on a refund; nets against commission." },
  { matchKey: "Refund|ItemFees|RefundCommission", side: "PNL", category: "MARKETPLACE_FEE", subcategory: "refund_administration", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Refund administration fee Amazon keeps." },
  { matchKey: "Refund|ItemFees|ShippingChargeback", side: "PNL", category: "FULFILMENT", subcategory: "shipping_chargeback", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Shipping chargeback returned on a refund." },
  { matchKey: "Refund|Promotion|Shipping", side: "PNL", category: "PROMOTION", subcategory: "shipping", quantityRule: "NONE", attribution: "ORDER_LINE", note: "Shipping promotion reversed on a refund." },
  { matchKey: "ServiceFee|Cost of Advertising|TransactionTotalAmount", side: "PNL", category: "ADVERTISING", subcategory: "sponsored_ads", quantityRule: "NONE", attribution: "MARKETPLACE", note: "Sponsored ads spend. No SKU; stays at marketplace level (A7)." },
  { matchKey: "AmazonFees|Premium Services Fee|Base fee", side: "PNL", category: "MARKETPLACE_FEE", subcategory: "premium_services", quantityRule: "NONE", attribution: "MARKETPLACE", note: "Amazon Selling Partner 360 (SP 360) service fee, confirmed by the owner. A marketplace fee, not advertising." },
  { matchKey: "AmazonFees|Premium Services Fee|Tax on fee", side: "TAX", category: "FEE_VAT", subcategory: "premium_services", quantityRule: "NONE", attribution: "MARKETPLACE", note: "5% VAT on the SP 360 fee. Owner decision: a separate VAT line; whether it counts in profit is decision B1." },
  { matchKey: "FBAFees|FBA Inventory Storage Fee|Base fee", side: "PNL", category: "FULFILMENT", subcategory: "storage", quantityRule: "NONE", attribution: "MARKETPLACE", note: "FBA storage fee. A reported 0.00 is a recorded zero, not a blank." },
]

/* ---- detection ----------------------------------------------------------- */

const normalizeHeader = (header: string) => header.trim().toLowerCase()

const REJECTIONS: { formatId: string; matches: (headers: Set<string>) => boolean; message: string }[] = [
  {
    formatId: "amazon.settlement.flat_file_v1",
    matches: (h) => h.has("price-type") || h.has("item-related-fee-type") || h.has("shipment-fee-type"),
    message:
      "This is Amazon's older flat-file settlement report, which Amazon has deprecated. In Seller Central, " +
      "open Payments → Reports repository and download the settlement report as Flat File V2, then upload that.",
  },
  {
    formatId: "amazon.date_range_transaction",
    matches: (h) =>
      h.has("date/time") || h.has("settlement id") || h.has("product sales") || h.has("amazon fees") ||
      h.has("selling fees") || h.has("fba fees"),
    message:
      "This is Amazon's Date Range / transaction report. It leaves the SKU off most rows and lumps Amazon's " +
      "fees together, so profit cannot be worked out from it. In Seller Central, open Payments → Reports " +
      "repository and download the settlement report as Flat File V2 instead.",
  },
  {
    formatId: "amazon.settlement.summary",
    matches: (h) => h.has("total sales") || h.has("total expense") || h.has("product wholesale price"),
    message:
      "This is an Amazon settlement summary. It has one line per period, not per transaction, so BizMind " +
      "cannot tell sales, fees and refunds apart. Download the settlement report as Flat File V2 instead.",
  },
]

function detect(sample: { headers: readonly string[] }): DetectResult {
  const headers = new Set(sample.headers.map(normalizeHeader))
  const missing = AMAZON_V2_HEADERS.filter((header) => !headers.has(header))

  if (missing.length === 0) {
    const extras = headers.size > AMAZON_V2_HEADERS.length
    return { kind: "match", formatId: AMAZON_V2_FORMAT_ID, confidence: extras ? "likely" : "exact" }
  }

  for (const rejection of REJECTIONS) {
    if (rejection.matches(headers)) {
      return { kind: "reject", formatId: rejection.formatId, message: rejection.message }
    }
  }

  return { kind: "unknown" }
}

/* ---- values -------------------------------------------------------------- */

const EXACT_DECIMAL = /^-?[0-9]{1,16}(\.[0-9]{1,4})?$/

function text(raw: Readonly<Record<string, string | null>>, column: string): string | null {
  const value = raw[column]
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

function isRealDate(year: number, month: number, day: number, hour: number, minute: number, second: number) {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/**
 * An Amazon timestamp as an ISO-8601 instant in UTC, or null when it cannot be
 * read with certainty. Two shapes only; nothing is inferred.
 */
export function parseAmazonInstant(value: string | null): string | null {
  if (value === null) return null
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2}) UTC$/.exec(value)
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?: UTC|Z)?$/.exec(value)

  let parts: [string, string, string, string, string, string] | null = null
  if (dotted) parts = [dotted[3], dotted[2], dotted[1], dotted[4], dotted[5], dotted[6]]
  else if (iso) parts = [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]]
  if (!parts) return null

  const [y, mo, d, h, mi, s] = parts
  if (!isRealDate(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s))) return null
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
}

/** Changes the sign of exact decimal text. Text in, text out: not arithmetic. */
export function negateDecimalText(value: string): string {
  if (/^-?0+(\.0+)?$/.test(value)) return value.replace(/^-/, "")
  return value.startsWith("-") ? value.slice(1) : `-${value}`
}

/* ---- normalisation ------------------------------------------------------- */

type SettlementHeader = { id: string; currency: string; readable: boolean }

function normalize(input: NormalizeInput): NormalizeResult {
  const rules = new Map<string, MappingRuleSummary>(input.rules.map((rule) => [rule.matchKey, rule]))
  const settlements: SettlementDraft[] = []
  const payouts: PayoutDraft[] = []
  const transactions: TransactionDraft[] = []
  const issues: RowIssue[] = []
  const headers = new Map<string, SettlementHeader>()

  const issue = (rowNumber: number, severity: "ERROR" | "WARNING", message: string, field?: string, rawValue?: string | null) =>
    issues.push({ rowNumber, severity, message, field, rawValue: rawValue ?? undefined })

  // First pass: settlement header rows (no amount, but a total).
  for (const row of input.rows) {
    const amount = text(row.raw, "amount")
    const total = text(row.raw, "total-amount")
    if (amount !== null || total === null) continue

    const id = text(row.raw, "settlement-id")
    if (id === null) {
      issue(row.rowNumber, "ERROR", "This settlement header has no settlement id.", "settlement-id")
      continue
    }
    if (headers.has(id)) {
      issue(row.rowNumber, "ERROR", `Settlement ${id} has more than one header row.`, "settlement-id", id)
      continue
    }

    const currency = text(row.raw, "currency")
    const start = text(row.raw, "settlement-start-date")
    const end = text(row.raw, "settlement-end-date")
    const deposit = text(row.raw, "deposit-date")
    const periodStart = parseAmazonInstant(start)
    const periodEnd = parseAmazonInstant(end)
    const depositDate = parseAmazonInstant(deposit)

    const problems: [string, string, string | null][] = []
    if (!EXACT_DECIMAL.test(total)) problems.push(["total-amount", "The settlement total is not a plain decimal number.", total])
    if (currency === null || !/^[A-Z]{3}$/.test(currency)) problems.push(["currency", "The settlement currency is missing or not a currency code.", currency])
    if (start !== null && periodStart === null) problems.push(["settlement-start-date", "The settlement start date could not be read.", start])
    if (end !== null && periodEnd === null) problems.push(["settlement-end-date", "The settlement end date could not be read.", end])
    if (deposit !== null && depositDate === null) problems.push(["deposit-date", "The deposit date could not be read.", deposit])

    if (problems.length > 0) {
      for (const [field, message, rawValue] of problems) issue(row.rowNumber, "ERROR", message, field, rawValue)
      headers.set(id, { id, currency: currency ?? "", readable: false })
      continue
    }

    headers.set(id, { id, currency: currency!, readable: true })
    settlements.push({
      externalSettlementId: id,
      sourceRowNumber: row.rowNumber,
      periodStart,
      periodEnd,
      reportedTotal: total,
      reportedDepositDate: depositDate,
      currency: currency!,
    })
    // What Amazon reports it is paying: the settlement total on the deposit
    // date (owner decision, 2026-09-15). Not a bank deposit (A9).
    payouts.push({
      key: `payout:${id}`,
      sourceRowNumber: row.rowNumber,
      externalRef: id,
      amount: total,
      currency: currency!,
      paidAt: depositDate,
      settlementRef: id,
    })
  }

  // Second pass: one amount per row.
  for (const row of input.rows) {
    const amount = text(row.raw, "amount")
    const total = text(row.raw, "total-amount")

    if (amount === null) {
      if (total === null) {
        issue(row.rowNumber, "WARNING", "This line has no amount and no settlement total, so there is nothing to record.")
      }
      continue
    }

    const id = text(row.raw, "settlement-id")
    const header = id === null ? undefined : headers.get(id)
    if (!header || !header.readable) {
      issue(
        row.rowNumber,
        "ERROR",
        id === null
          ? "This line has no settlement id, so its currency cannot be known."
          : `Settlement ${id} has no readable header row in this file, so this line's currency cannot be known.`,
        "settlement-id",
        id
      )
      continue
    }

    if (!EXACT_DECIMAL.test(amount)) {
      issue(row.rowNumber, "ERROR", "The amount is not a plain decimal number (a dot, no thousands separators).", "amount", amount)
      continue
    }

    const postedRaw = text(row.raw, "posted-date-time")
    const postedAt = parseAmazonInstant(postedRaw)
    if (postedAt === null) {
      issue(row.rowNumber, "ERROR", "The posted date and time could not be read.", "posted-date-time", postedRaw)
      continue
    }

    const transactionType = text(row.raw, "transaction-type") ?? ""
    const amountType = text(row.raw, "amount-type") ?? ""
    const amountDescription = text(row.raw, "amount-description") ?? ""
    const rule = rules.get(amazonMatchKey(transactionType, amountType, amountDescription))
    const orderRef = text(row.raw, "order-id")

    let quantity: string | null = null
    let quantityBasis: TransactionDraft["quantityBasis"] = null
    if (rule?.quantityRule === "COUNT_LINE") {
      quantity = "1"
      quantityBasis = "DERIVED_LINE_COUNT"
    } else if (rule?.quantityRule === "REPORTED") {
      const reported = text(row.raw, "quantity-purchased")
      if (reported !== null && EXACT_DECIMAL.test(reported)) {
        quantity = reported
        quantityBasis = "REPORTED"
      } else if (reported !== null) {
        issue(row.rowNumber, "WARNING", "The quantity could not be read, so it is left unknown.", "quantity-purchased", reported)
      }
    }

    if (!rule) {
      issue(
        row.rowNumber,
        "WARNING",
        `"${transactionType} / ${amountType} / ${amountDescription}" is not an Amazon code BizMind recognises yet. ` +
          "The line is kept and counted in no total until it is classified.",
        "amount-description",
        amount
      )
    }

    transactions.push({
      sourceRowNumber: row.rowNumber,
      lineIndex: 0,
      mappingRuleId: rule?.id ?? null,
      side: rule?.side ?? null,
      category: rule?.category ?? UNMAPPED,
      subcategory: rule?.subcategory ?? null,
      sourceType: transactionType || null,
      sourceSubtype: amountType || null,
      sourceDescription: amountDescription || null,
      amount: rule?.signRule === "NEGATE" ? negateDecimalText(amount) : amount,
      currency: header.currency,
      postedAt,
      orderRef,
      orderLineRef: text(row.raw, "order-item-code"),
      rawSku: text(row.raw, "sku"),
      quantity,
      quantityBasis,
      attribution: rule?.attribution ?? (orderRef ? "ORDER_LINE" : "MARKETPLACE"),
      settlementRef: header.id,
      payoutRef: null,
    })
  }

  return { transactions, settlements, payouts, issues }
}

export const amazonFlatFileV2Adapter: MarketplaceAdapter = {
  marketplace: "AMAZON",
  formats: [amazonFlatFileV2Format],
  detect,
  normalize,
}
