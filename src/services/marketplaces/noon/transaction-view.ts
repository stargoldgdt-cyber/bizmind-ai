import type { RowIssue } from "@/services/ingestion/contracts"

import type {
  FormatDescriptor,
  MappingRuleSummary,
  NormalizeInput,
  NormalizeResult,
  PayoutDraft,
  TransactionDraft,
} from "../contract"
import { UNMAPPED } from "../contract"
import { NOON_TV_FORMAT_ID, NOON_TV_PART_COLUMNS, noonTvMatchKey } from "./rules"
import { EXACT_DECIMAL, cell, isZeroDecimal, negateDecimal, parseNoonDate } from "./values"

/**
 * noon "Transaction View (item level, with contract selection)".
 *
 * One row per transaction; each money column is its own ledger line (a
 * reported zero adds nothing and is skipped). Verified on the owner's July 2026
 * export: the columns always add up to the row total, and noon states no VAT
 * here -- fee columns include it (see rules.ts).
 *
 * A row in another currency belongs to another noon contract (the owner's
 * "Noon SA" contract reports in SAR); it is kept with a warning and recorded
 * only when the file is uploaded to that account.
 */

export const NOON_TV_HEADERS = [
  "Contract",
  "Contract Title",
  "Reference Nr",
  "Order Nr",
  "Item Nr",
  "Order Date",
  "Transaction Date",
  "Title",
  "Product Fulltype Code",
  "Family",
  "SKUs",
  "Partner SKUs",
  "Transaction Type",
  "Currency",
  "Net Proceeds",
  "Referral Fee including VAT",
  "Fullfilment & Logistics Fees including VAT",
  "Shipping Credits including VAT",
  "Other Order Fees including VAT",
  "Order Subsidies including VAT",
  "Non-Order Fees including VAT",
  "Non-Order Subsidies including VAT",
  "Others including VAT",
  "Total",
] as const

export const noonTransactionViewFormat: FormatDescriptor = {
  id: NOON_TV_FORMAT_ID,
  label: "noon Transaction View (item level)",
  adapterVersion: "1.0.0",
  requiredHeaders: NOON_TV_HEADERS,
  // No column carries customer data (verified on the real export).
  allowedColumns: NOON_TV_HEADERS,
}

const ORDER_TYPES = new Set(["order", "order_update"])

export function normalizeTransactionView(input: NormalizeInput): NormalizeResult {
  const rules = new Map<string, MappingRuleSummary>(input.rules.map((rule) => [rule.matchKey, rule]))
  const transactions: TransactionDraft[] = []
  const payouts: PayoutDraft[] = []
  const issues: RowIssue[] = []

  const issue = (rowNumber: number, severity: "ERROR" | "WARNING", message: string, field?: string, rawValue?: string | null) =>
    issues.push({ rowNumber, severity, message, field, rawValue: rawValue ?? undefined })

  for (const row of input.rows) {
    const type = cell(row.raw, "Transaction Type")
    const currency = cell(row.raw, "Currency")
    const dateRaw = cell(row.raw, "Transaction Date")

    if (type === null) {
      issue(row.rowNumber, "ERROR", "This row has no transaction type.", "Transaction Type")
      continue
    }
    if (currency === null || !/^[A-Z]{3}$/.test(currency)) {
      issue(row.rowNumber, "ERROR", "The currency is missing or not a currency code.", "Currency", currency)
      continue
    }
    if (currency !== input.account.currency) {
      issue(
        row.rowNumber,
        "WARNING",
        `This row is in ${currency} and belongs to the noon contract "${cell(row.raw, "Contract Title") ?? "unnamed"}". ` +
          `It is not counted in this ${input.account.currency} account; upload the same file to your ${currency} noon account.`,
        "Currency",
        currency
      )
      continue
    }

    const postedAt = parseNoonDate(dateRaw)
    if (postedAt === null) {
      issue(row.rowNumber, "ERROR", "The transaction date could not be read (expected YYYY-MM-DD).", "Transaction Date", dateRaw)
      continue
    }

    const parts: { column: string; amount: string }[] = []
    let unreadable = false
    for (const column of NOON_TV_PART_COLUMNS) {
      const value = cell(row.raw, column)
      if (value === null || (EXACT_DECIMAL.test(value) && isZeroDecimal(value))) continue
      if (!EXACT_DECIMAL.test(value)) {
        issue(row.rowNumber, "ERROR", "This amount is not a plain decimal number.", column, value)
        unreadable = true
        continue
      }
      parts.push({ column, amount: value })
    }
    if (unreadable) continue

    if (parts.length === 0) {
      issue(row.rowNumber, "WARNING", "This row has no amount other than zero, so there is nothing to record.")
      continue
    }

    const orderNr = cell(row.raw, "Order Nr")
    // noon writes the literal "NA" where a row has no order.
    const orderRef = orderNr !== null && orderNr.toUpperCase() !== "NA" ? orderNr : null
    const itemNr = cell(row.raw, "Item Nr")
    const detail = ORDER_TYPES.has(type)
      ? itemNr !== null
        ? "item"
        : "order"
      : type === "balance_transfer"
        ? ""
        : (cell(row.raw, "Title") ?? "")

    let payoutKey: string | null = null
    if (type === "payment") {
      const total = cell(row.raw, "Total")
      if (total === null || !EXACT_DECIMAL.test(total)) {
        issue(row.rowNumber, "ERROR", "The payment total could not be read.", "Total", total)
        continue
      }
      payoutKey = `payout:${row.rowNumber}`
      // noon shows a payment as money leaving the balance (negative); the
      // payout is what noon reports sending to the seller.
      payouts.push({
        key: payoutKey,
        sourceRowNumber: row.rowNumber,
        externalRef: cell(row.raw, "Reference Nr"),
        amount: negateDecimal(total),
        currency,
        paidAt: postedAt,
        settlementRef: null,
      })
    }

    parts.forEach((part, lineIndex) => {
      const rule = rules.get(noonTvMatchKey(type, part.column, detail))

      if (!rule) {
        issue(
          row.rowNumber,
          "WARNING",
          `"${type} / ${part.column}${detail ? ` / ${detail}` : ""}" is not a noon code BizMind recognises yet. ` +
            "The line is kept and counted in no total until it is classified.",
          part.column,
          part.amount
        )
      }

      transactions.push({
        sourceRowNumber: row.rowNumber,
        lineIndex,
        mappingRuleId: rule?.id ?? null,
        side: rule?.side ?? null,
        category: rule?.category ?? UNMAPPED,
        subcategory: rule?.subcategory ?? null,
        sourceType: type,
        sourceSubtype: part.column,
        sourceDescription: detail || null,
        amount: rule?.signRule === "NEGATE" ? negateDecimal(part.amount) : part.amount,
        currency,
        postedAt,
        orderRef,
        orderLineRef: itemNr,
        rawSku: cell(row.raw, "Partner SKUs"),
        quantity: rule?.quantityRule === "COUNT_LINE" ? "1" : null,
        quantityBasis: rule?.quantityRule === "COUNT_LINE" ? "DERIVED_LINE_COUNT" : null,
        attribution: rule?.attribution ?? (itemNr ? "ORDER_LINE" : orderRef ? "ORDER" : "MARKETPLACE"),
        settlementRef: null,
        payoutRef: payoutKey,
      })
    })
  }

  return { transactions, settlements: [], payouts, issues }
}
