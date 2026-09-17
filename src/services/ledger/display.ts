/**
 * Small presentation helpers for ledger screens. No arithmetic.
 */

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })

/** "4 Jul 2026", in UTC -- the time zone the P&L engine counts in. */
export function formatLedgerDay(iso: string | null | undefined): string {
  if (!iso) return "—"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "—" : DAY.format(date)
}

/**
 * The size of an amount without its sign, as exact text.
 *
 * Used only where a sentence already says what the amount is ("VAT treatment
 * unknown: AED 119.79" for VAT the marketplace charged). It removes a leading
 * minus character; it never calculates.
 */
export function unsignedAmount(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value.startsWith("-") ? value.slice(1) : value
}

export const FINANCIAL_TYPE_LABEL: Record<string, string> = {
  REVENUE: "Revenue",
  EXPENSE: "Expense",
  TAX: "Tax",
  CASH: "Cash",
  MEMO: "Memo",
}

export const TREATMENT_LABEL: Record<string, string> = {
  INCREASE_REVENUE: "Adds to revenue",
  DECREASE_REVENUE: "Reduces revenue",
  INCREASE_EXPENSE: "Adds to costs",
  NO_PNL_IMPACT: "Not in profit",
  CONDITIONAL: "Waiting for the VAT setting",
}

export const CLASSIFICATION_STATUS_LABEL: Record<string, string> = {
  CLASSIFIED: "Classified",
  UNDER_REVIEW: "Under review",
  UNKNOWN: "Not recognised",
}

export const INPUT_VAT_TREATMENT_LABEL: Record<string, string> = {
  UNKNOWN: "Unknown",
  RECOVERABLE: "Recoverable",
  NON_RECOVERABLE: "Non-recoverable",
}
