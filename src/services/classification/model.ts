/**
 * The classification model: Financial Type -> Category -> Subcategory -> P&L
 * Treatment (ARCHITECTURE_BASELINE.md section C, "Automatic classification").
 *
 * The database is the authority (migration 0032, classification_categories);
 * this file mirrors it so application code can name categories and statuses
 * without guessing. `npm run test:classification` fails if the two differ.
 *
 * Nothing here computes a figure. Every total comes from SQL as exact text.
 */

export const FINANCIAL_TYPES = ["REVENUE", "EXPENSE", "TAX", "CASH", "MEMO"] as const
export type FinancialType = (typeof FINANCIAL_TYPES)[number]

export const PNL_TREATMENTS = [
  "INCREASE_REVENUE",
  "DECREASE_REVENUE",
  "INCREASE_EXPENSE",
  "NO_PNL_IMPACT",
  "CONDITIONAL",
] as const
export type PnlTreatment = (typeof PNL_TREATMENTS)[number]

/** The figure a category adds into. */
export const METRIC_GROUPS = [
  "GROSS_SALES",
  "SALES_REFUNDS",
  "SELLER_DISCOUNTS",
  "OTHER_INCOME",
  "MARKETPLACE_FEES",
  "FULFILLMENT",
  "ADVERTISING",
  "OTHER_MARKETPLACE_COSTS",
  "INPUT_VAT",
  "OUTPUT_VAT",
  "CASH",
  "MEMO",
] as const
export type MetricGroup = (typeof METRIC_GROUPS)[number]

export type ClassificationCategory = {
  code: string
  financialType: FinancialType
  label: string
  defaultTreatment: PnlTreatment
  metricGroup: MetricGroup
  sortOrder: number
}

export const CLASSIFICATION_CATEGORIES = [
  { code: "PRODUCT_SALES", financialType: "REVENUE", label: "Product sales", defaultTreatment: "INCREASE_REVENUE", metricGroup: "GROSS_SALES", sortOrder: 10 },
  { code: "SHIPPING_INCOME", financialType: "REVENUE", label: "Shipping income", defaultTreatment: "INCREASE_REVENUE", metricGroup: "GROSS_SALES", sortOrder: 20 },
  { code: "SALES_REFUNDS", financialType: "REVENUE", label: "Sales refunds and returns", defaultTreatment: "DECREASE_REVENUE", metricGroup: "SALES_REFUNDS", sortOrder: 30 },
  { code: "SELLER_DISCOUNTS", financialType: "REVENUE", label: "Seller-funded discounts", defaultTreatment: "DECREASE_REVENUE", metricGroup: "SELLER_DISCOUNTS", sortOrder: 40 },
  { code: "OTHER_INCOME", financialType: "REVENUE", label: "Other income", defaultTreatment: "INCREASE_REVENUE", metricGroup: "OTHER_INCOME", sortOrder: 50 },
  { code: "REIMBURSEMENT", financialType: "REVENUE", label: "Reimbursements", defaultTreatment: "INCREASE_REVENUE", metricGroup: "OTHER_INCOME", sortOrder: 60 },
  { code: "SUBSIDY_INCOME", financialType: "REVENUE", label: "Subsidy and promotion income", defaultTreatment: "INCREASE_REVENUE", metricGroup: "OTHER_INCOME", sortOrder: 70 },
  { code: "MARKETPLACE_FEE", financialType: "EXPENSE", label: "Marketplace fees", defaultTreatment: "INCREASE_EXPENSE", metricGroup: "MARKETPLACE_FEES", sortOrder: 110 },
  { code: "PAYMENT_FEE", financialType: "EXPENSE", label: "Payment and COD fees", defaultTreatment: "INCREASE_EXPENSE", metricGroup: "MARKETPLACE_FEES", sortOrder: 120 },
  { code: "REFUND_FEE", financialType: "EXPENSE", label: "Refund fees", defaultTreatment: "INCREASE_EXPENSE", metricGroup: "MARKETPLACE_FEES", sortOrder: 130 },
  { code: "FULFILLMENT", financialType: "EXPENSE", label: "Fulfillment and logistics", defaultTreatment: "INCREASE_EXPENSE", metricGroup: "FULFILLMENT", sortOrder: 140 },
  { code: "STORAGE", financialType: "EXPENSE", label: "Storage", defaultTreatment: "INCREASE_EXPENSE", metricGroup: "FULFILLMENT", sortOrder: 150 },
  { code: "ADVERTISING", financialType: "EXPENSE", label: "Advertising", defaultTreatment: "INCREASE_EXPENSE", metricGroup: "ADVERTISING", sortOrder: 160 },
  { code: "PENALTY", financialType: "EXPENSE", label: "Penalties", defaultTreatment: "INCREASE_EXPENSE", metricGroup: "OTHER_MARKETPLACE_COSTS", sortOrder: 170 },
  { code: "OTHER_MARKETPLACE_EXPENSE", financialType: "EXPENSE", label: "Other marketplace expenses", defaultTreatment: "INCREASE_EXPENSE", metricGroup: "OTHER_MARKETPLACE_COSTS", sortOrder: 180 },
  { code: "INPUT_VAT", financialType: "TAX", label: "Input VAT", defaultTreatment: "CONDITIONAL", metricGroup: "INPUT_VAT", sortOrder: 210 },
  { code: "OUTPUT_VAT", financialType: "TAX", label: "Output VAT", defaultTreatment: "NO_PNL_IMPACT", metricGroup: "OUTPUT_VAT", sortOrder: 220 },
  { code: "PAYOUT", financialType: "CASH", label: "Payouts", defaultTreatment: "NO_PNL_IMPACT", metricGroup: "CASH", sortOrder: 310 },
  { code: "RESERVE_HOLD", financialType: "CASH", label: "Reserve held", defaultTreatment: "NO_PNL_IMPACT", metricGroup: "CASH", sortOrder: 320 },
  { code: "RESERVE_RELEASE", financialType: "CASH", label: "Reserve released", defaultTreatment: "NO_PNL_IMPACT", metricGroup: "CASH", sortOrder: 330 },
  { code: "TRANSFER", financialType: "CASH", label: "Transfers", defaultTreatment: "NO_PNL_IMPACT", metricGroup: "CASH", sortOrder: 340 },
  { code: "REPORT_TOTAL", financialType: "MEMO", label: "Report totals", defaultTreatment: "NO_PNL_IMPACT", metricGroup: "MEMO", sortOrder: 410 },
  { code: "REPORT_RESULT", financialType: "MEMO", label: "Report results", defaultTreatment: "NO_PNL_IMPACT", metricGroup: "MEMO", sortOrder: 420 },
  { code: "INFORMATIONAL", financialType: "MEMO", label: "Informational", defaultTreatment: "NO_PNL_IMPACT", metricGroup: "MEMO", sortOrder: 430 },
] as const satisfies readonly ClassificationCategory[]

export type CategoryCode = (typeof CLASSIFICATION_CATEGORIES)[number]["code"]

/** CLASSIFIED: a HIGH rule or the business's own; UNDER_REVIEW: a MEDIUM rule; UNKNOWN: no rule. */
export type ClassificationStatus = "CLASSIFIED" | "UNDER_REVIEW" | "UNKNOWN"

export type FigureStatus = "FINAL" | "INCOMPLETE"

export type IncompleteReason = "UNKNOWN_LINES" | "VAT_TREATMENT_UNKNOWN" | "ROW_ERRORS"

/** The account's VAT setting (B1). */
export const INPUT_VAT_TREATMENTS = ["UNKNOWN", "RECOVERABLE", "NON_RECOVERABLE"] as const
export type InputVatTreatment = (typeof INPUT_VAT_TREATMENTS)[number]

export type DataQualityKind =
  | "UNKNOWN_CODE"
  | "UNDER_REVIEW"
  | "VAT_TREATMENT_UNKNOWN"
  | "ROW_ERRORS"
  | "SETTLEMENT_MISMATCH"

/**
 * The key a ledger line is matched on, mirroring
 * `public.classification_match_key()`: the three source codes joined with "|",
 * a blank part as an empty string.
 */
export function classificationMatchKey(
  sourceType: string | null,
  sourceSubtype: string | null,
  sourceDescription: string | null
): string {
  return [sourceType ?? "", sourceSubtype ?? "", sourceDescription ?? ""].join("|")
}
