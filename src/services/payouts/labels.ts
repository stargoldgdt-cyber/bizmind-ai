import type { BankReceiptStatus, ExpectedPayoutSource, ExpectedPayoutStatus } from "@/types/database"

/**
 * Words for expected payouts (GCC Phase 8). No arithmetic.
 *
 * The owner's rule: an amount from a marketplace report is an EXPECTED
 * payout. It is never described as received. "Actual bank receipt" is its own
 * concept and reads "Not connected" until a bank source exists.
 */

export const EXPECTED_PAYOUT_LABEL = "Expected marketplace payout"
export const BANK_RECEIPT_LABEL = "Actual bank receipt"

export const PAYOUT_SOURCE_LABEL: Record<ExpectedPayoutSource, string> = {
  SETTLEMENT_REPORT: "Settlement report total",
  MARKETPLACE_PAYMENT_REPORT: "Payment the marketplace reports sending",
}

export const PAYOUT_STATUS_LABEL: Record<ExpectedPayoutStatus, string> = {
  ADDS_UP: "Settlement adds up",
  DOES_NOT_ADD_UP: "Settlement does not add up",
  NO_TOTAL: "No total in the report",
  MARKETPLACE_PAYMENT: "Reported by the marketplace",
}

export const PAYOUT_STATUS_HELP: Record<ExpectedPayoutStatus, string> = {
  ADDS_UP: "The settlement's reported total equals the sum of its lines.",
  DOES_NOT_ADD_UP: "The reported total differs from the sum of its lines, so the expected payout is in doubt.",
  NO_TOTAL: "The report states no total, so there is no expected amount.",
  MARKETPLACE_PAYMENT: "A payout the marketplace reports sending; it is not tied to a settlement total.",
}

export const BANK_RECEIPT_STATUS_LABEL: Record<BankReceiptStatus, string> = {
  NOT_CONNECTED: "Not connected",
}
