import type { RowIssue } from "@/services/ingestion/contracts"

/**
 * The marketplace adapter contract.
 *
 * PHASE 1: CONTRACT ONLY. No Amazon, noon or Carrefour adapter exists yet, and
 * the registry starts empty. See ARCHITECTURE_BASELINE.md and LEDGER.md.
 *
 * TRANSPORT AND MEANING ARE SEPARATE
 * ----------------------------------
 * A transport gets rows: an upload, a marketplace API later. An adapter knows
 * what ONE marketplace format means. It turns source rows into drafts; it never
 * writes anything. `ledger_apply_file()` in the database is the only writer, and
 * `ledger-file.ts` builds its payload.
 *
 * EVERY SOURCE ROW ENDS UP SOMEWHERE
 * ----------------------------------
 * A row becomes a transaction, a settlement, a payout, or a row issue. The
 * database refuses a file in which any row is none of those, so an adapter
 * cannot drop a row silently.
 *
 * MONEY IS TEXT
 * -------------
 * Amounts are exact decimal strings, exactly as the source wrote them (after
 * the adapter's documented sign rule). An adapter never parses one into a
 * JavaScript number and never does arithmetic on it (MONEY.md).
 */

export const LEDGER_SIDES = ["PNL", "CASH", "TAX", "MEMO"] as const
export type LedgerSide = (typeof LEDGER_SIDES)[number]

/** The closed category list per side. Mirrors `ledger_category_valid()` in migration 0030. */
export const LEDGER_CATEGORIES = {
  PNL: [
    "REVENUE",
    "REFUND",
    "MARKETPLACE_FEE",
    "FULFILMENT",
    "PROMOTION",
    "SUBSIDY",
    "ADVERTISING",
    "REIMBURSEMENT",
    "OTHER_INCOME",
    "OTHER_COST",
  ],
  CASH: ["PAYOUT", "RESERVE_HOLD", "RESERVE_RELEASE", "BALANCE_CARRIED", "TRANSFER"],
  TAX: ["OUTPUT_VAT", "FEE_VAT", "OTHER_TAX"],
  MEMO: ["SETTLEMENT_TOTAL", "INFORMATIONAL"],
} as const satisfies Record<LedgerSide, readonly string[]>

export type LedgerCategory = (typeof LEDGER_CATEGORIES)[LedgerSide][number]

/** A line no mapping rule recognised. Kept, reported, counted in no total. */
export const UNMAPPED = "UNMAPPED" as const

export type Attribution = "ORDER_LINE" | "ORDER" | "MARKETPLACE"
export type QuantityBasis = "REPORTED" | "DERIVED_LINE_COUNT"

/** Exact decimal text: up to 16 integer digits and 4 decimal places. */
export type ExactDecimalText = string

/** An ISO-8601 instant with an explicit offset, e.g. `2026-09-01T10:00:00Z`. */
export type InstantText = string

/** One parsed row, as the text that was read. A blank cell is `null`, never `""` or `"0"`. */
export type SourceRow = {
  rowNumber: number
  raw: Record<string, string | null>
}

export type FormatDescriptor = {
  /** Stable id, e.g. `amazon.settlement.flat_file_v2`. Recorded on the source file. */
  id: string
  label: string
  /** Recorded on every file so a figure can be traced to the code that read it. */
  adapterVersion: string
  /** Headers whose absence means "this is not the format". */
  requiredHeaders: readonly string[]
  /**
   * The ONLY columns stored in `source_rows`. Anything else is dropped before
   * storage and recorded in `stripped_columns`. A customer-data column can never
   * be allowed: the registry refuses the format.
   */
  allowedColumns: readonly string[]
}

export type DetectSample = {
  fileName: string
  headers: readonly string[]
  /** The first few data rows, as text. */
  rows: readonly (readonly string[])[]
}

export type DetectResult =
  | { kind: "match"; formatId: string; confidence: "exact" | "likely" }
  /** A known format that must not be used, with what to download instead. */
  | { kind: "reject"; formatId: string; message: string }
  | { kind: "unknown" }

/** A mapping rule as an adapter sees it. The database re-checks every field. */
export type MappingRuleSummary = {
  id: string
  matchKey: string
  side: LedgerSide
  category: LedgerCategory
  subcategory: string | null
  attribution: Attribution
  quantityRule: "NONE" | "REPORTED" | "COUNT_LINE"
  signRule: "AS_REPORTED" | "NEGATE"
}

export type TransactionDraft = {
  sourceRowNumber: number
  /** Several amounts can come from one row; each gets its own index. */
  lineIndex: number
  /** `null` means UNMAPPED. */
  mappingRuleId: string | null
  side: LedgerSide | null
  category: LedgerCategory | typeof UNMAPPED
  subcategory: string | null
  sourceType: string | null
  sourceSubtype: string | null
  sourceDescription: string | null
  amount: ExactDecimalText
  currency: string
  postedAt: InstantText
  orderRef: string | null
  orderLineRef: string | null
  rawSku: string | null
  quantity: ExactDecimalText | null
  quantityBasis: QuantityBasis | null
  attribution: Attribution
  settlementRef: string | null
  payoutRef: string | null
}

export type SettlementDraft = {
  externalSettlementId: string
  sourceRowNumber: number
  periodStart: InstantText | null
  periodEnd: InstantText | null
  /** Blank stays blank. */
  reportedTotal: ExactDecimalText | null
  reportedDepositDate: InstantText | null
  currency: string
}

export type PayoutDraft = {
  /** Local to this file; transactions point at it with `payoutRef`. */
  key: string
  sourceRowNumber: number
  externalRef: string | null
  amount: ExactDecimalText
  currency: string
  paidAt: InstantText | null
  settlementRef: string | null
}

export type NormalizeInput = {
  formatId: string
  rows: readonly SourceRow[]
  account: { id: string; marketplaceCode: string; currency: string }
  rules: readonly MappingRuleSummary[]
}

export type NormalizeResult = {
  transactions: readonly TransactionDraft[]
  settlements: readonly SettlementDraft[]
  payouts: readonly PayoutDraft[]
  issues: readonly RowIssue[]
}

export type MarketplaceAdapter = {
  /** A `marketplaces.code`, e.g. `AMAZON`. */
  marketplace: string
  formats: readonly FormatDescriptor[]
  /** Pure. Looks at headers and a sample; never at the whole file. */
  detect(sample: DetectSample): DetectResult
  /** Pure: rows in, drafts out. No database, no network, no money arithmetic. */
  normalize(input: NormalizeInput): NormalizeResult
}
