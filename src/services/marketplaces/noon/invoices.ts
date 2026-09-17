import type { RowIssue } from "@/services/ingestion/contracts"

import type {
  FormatDescriptor,
  MappingRuleSummary,
  NormalizeInput,
  NormalizeResult,
  TransactionDraft,
} from "../contract"
import { UNMAPPED } from "../contract"
import { NOON_INVOICES_FORMAT_ID, NOON_INVOICE_FEES, noonInvoiceMatchKey } from "./rules"
import { EXACT_DECIMAL, cell, negateDecimal, parseNoonDate } from "./values"

/**
 * noon "Invoices and Credit Notes".
 *
 * Two kinds of line matter:
 *
 *   Statement Fee -- noon's VAT invoice for its own fees. The Transaction View
 *   already counted each fee INCLUDING VAT, so every invoice line becomes two
 *   ledger lines: the stated VAT taken back out of the fee's category, and the
 *   same VAT as Input VAT. Together they add to zero, so no money is invented;
 *   the account's VAT setting then decides whether the VAT is a cost (B1).
 *
 *   Customer -- noon's invoice or credit note to a buyer. Only its stated VAT
 *   is recorded, as Output VAT (tax only; sales stay as noon reports them).
 *
 * The buyer's name, tax number, city and location are never stored: those
 * columns are not in `allowedColumns`, so they are dropped before storage.
 */

export const NOON_INVOICE_HEADERS = [
  "Contract",
  "Business Unit",
  "Document Type",
  "Invoice Type Code",
  "Document Subtype",
  "Document Date",
  "Invoice Nr",
  "Invoice Line Nr",
  "Credit Note Nr",
  "Credit Note Line Nr",
  "Transaction Type",
  "Source Doc Type",
  "Source Doc Nr",
  "Source Doc Line Type",
  "Source Doc Line Nr",
  "Description",
  "SKU",
  "Partner SKU",
  "Misc",
  "Issuer City",
  "Issuer Country",
  "Issuer Location",
  "Receiver City",
  "Receiver Country",
  "Receiver Location",
  "Issuer Legal Entity",
  "Issuer Legal Name",
  "Issuer TRN",
  "Receiver Legal Entity",
  "Receiver Legal Name",
  "Receiver TRN",
  "Document Currency",
  "VAT Currency",
  "VAT Rate",
  "FX Rate",
  "Price Excluding VAT (Document Currency)",
  "Price Excluding VAT (VAT Currency)",
  "VAT Amount (Document Currency)",
  "VAT Amount (VAT Currency)",
  "Price Including VAT (Document Currency)",
] as const

/** Everything that names, locates or identifies a party (and free-text Misc) stays out. */
const NOT_STORED = new Set([
  "Misc",
  "Issuer City",
  "Issuer Location",
  "Receiver City",
  "Receiver Country",
  "Receiver Location",
  "Issuer Legal Entity",
  "Issuer Legal Name",
  "Issuer TRN",
  "Receiver Legal Entity",
  "Receiver Legal Name",
  "Receiver TRN",
])

const STORED_HEADERS = NOON_INVOICE_HEADERS.filter((header) => !NOT_STORED.has(header))

// The registry requires every required header to be a stored one. Recognising
// the export uses the full heading list (see adapter.ts); what the reader
// needs, and keeps, is the stored subset.
export const noonInvoicesFormat: FormatDescriptor = {
  id: NOON_INVOICES_FORMAT_ID,
  label: "noon Invoices and Credit Notes",
  adapterVersion: "1.0.0",
  requiredHeaders: STORED_HEADERS,
  allowedColumns: STORED_HEADERS,
}

const WHOLE_AMOUNT_IS_VAT = new Set(NOON_INVOICE_FEES.filter((f) => f.wholeAmountIsVat).map((f) => f.fee))

export function normalizeInvoices(input: NormalizeInput): NormalizeResult {
  const rules = new Map<string, MappingRuleSummary>(input.rules.map((rule) => [rule.matchKey, rule]))
  const transactions: TransactionDraft[] = []
  const issues: RowIssue[] = []

  const issue = (rowNumber: number, severity: "ERROR" | "WARNING", message: string, field?: string, rawValue?: string | null) =>
    issues.push({ rowNumber, severity, message, field, rawValue: rawValue ?? undefined })

  for (const row of input.rows) {
    const documentType = cell(row.raw, "Document Type")
    const transactionType = cell(row.raw, "Transaction Type")
    const currency = cell(row.raw, "Document Currency")
    const dateRaw = cell(row.raw, "Document Date")

    if (documentType === null || transactionType === null) {
      issue(row.rowNumber, "ERROR", "This row has no document type or transaction type.", "Document Type")
      continue
    }
    if (currency === null || !/^[A-Z]{3}$/.test(currency)) {
      issue(row.rowNumber, "ERROR", "The document currency is missing or not a currency code.", "Document Currency", currency)
      continue
    }
    if (currency !== input.account.currency) {
      issue(
        row.rowNumber,
        "WARNING",
        `This document is in ${currency}, so it is not counted in this ${input.account.currency} account; ` +
          `upload the same file to your ${currency} noon account.`,
        "Document Currency",
        currency
      )
      continue
    }
    const postedAt = parseNoonDate(dateRaw)
    if (postedAt === null) {
      issue(row.rowNumber, "ERROR", "The document date could not be read (expected YYYY-MM-DD).", "Document Date", dateRaw)
      continue
    }

    const vat = cell(row.raw, "VAT Amount (Document Currency)")
    const included = cell(row.raw, "Price Including VAT (Document Currency)")
    const credit = documentType.toLowerCase() === "creditnote"

    const record = (lineIndex: number, matchKey: string, subtype: string, detail: string, amount: string, refs: { orderRef: string | null; orderLineRef: string | null; rawSku: string | null }) => {
      const rule = rules.get(matchKey)
      if (!rule) {
        issue(
          row.rowNumber,
          "WARNING",
          `"${transactionType} / ${subtype} / ${detail}" is not a noon invoice line BizMind recognises yet. ` +
            "The line is kept and counted in no total until it is classified.",
          "Description",
          amount
        )
      }
      transactions.push({
        sourceRowNumber: row.rowNumber,
        lineIndex,
        mappingRuleId: rule?.id ?? null,
        side: rule?.side ?? null,
        category: rule?.category ?? UNMAPPED,
        subcategory: rule?.subcategory ?? null,
        sourceType: transactionType,
        sourceSubtype: subtype,
        sourceDescription: detail,
        amount,
        currency,
        postedAt,
        orderRef: refs.orderRef,
        orderLineRef: refs.orderLineRef,
        rawSku: refs.rawSku,
        quantity: null,
        quantityBasis: null,
        attribution: rule?.attribution ?? (refs.orderRef ? "ORDER" : "MARKETPLACE"),
        settlementRef: null,
        payoutRef: null,
      })
    }

    if (transactionType === "Statement Fee") {
      const description = cell(row.raw, "Description")
      const fee = description === null ? null : description.includes(" : ") ? description.split(" : ").slice(1).join(" : ").trim() : description
      if (!fee) {
        issue(row.rowNumber, "ERROR", "This fee line has no description, so the fee cannot be named.", "Description")
        continue
      }

      const whole = WHOLE_AMOUNT_IS_VAT.has(fee)
      const stated = whole ? included : vat
      const statedColumn = whole ? "Price Including VAT (Document Currency)" : "VAT Amount (Document Currency)"
      if (stated === null || !EXACT_DECIMAL.test(stated)) {
        issue(row.rowNumber, "ERROR", "The VAT amount could not be read.", statedColumn, stated)
        continue
      }

      // noon states its charges as positive amounts. From the seller's side the
      // VAT is a cost (negative); taking it out of the fee is the opposite.
      // A credit note reverses both.
      const backOutOfFee = credit ? negateDecimal(stated) : stated
      const inputVat = negateDecimal(backOutOfFee)
      const refs = { orderRef: null, orderLineRef: cell(row.raw, "Source Doc Line Nr"), rawSku: null }
      record(0, noonInvoiceMatchKey("Statement Fee", "vat_included", fee), "vat_included", fee, backOutOfFee, refs)
      record(1, noonInvoiceMatchKey("Statement Fee", "input_vat", fee), "input_vat", fee, inputVat, refs)
      continue
    }

    if (transactionType === "Customer") {
      if (vat === null || !EXACT_DECIMAL.test(vat)) {
        issue(row.rowNumber, "ERROR", "The VAT amount could not be read.", "VAT Amount (Document Currency)", vat)
        continue
      }
      // Output VAT is owed on an invoice (negative from the seller's side) and
      // given back on a credit note.
      const amount = credit ? vat : negateDecimal(vat)
      const detail = credit ? "Creditnote" : "Invoice"
      record(0, noonInvoiceMatchKey("Customer", "output_vat", detail), "output_vat", detail, amount, {
        orderRef: cell(row.raw, "Source Doc Nr"),
        orderLineRef: cell(row.raw, "Source Doc Line Nr"),
        rawSku: cell(row.raw, "Partner SKU"),
      })
      continue
    }

    // A document kind BizMind has not seen: keep its stated amount, unclassified.
    if (included === null || !EXACT_DECIMAL.test(included)) {
      issue(row.rowNumber, "ERROR", `This "${transactionType}" document has no readable amount.`, "Price Including VAT (Document Currency)", included)
      continue
    }
    record(0, noonInvoiceMatchKey(transactionType, "document", documentType), "document", documentType, included, {
      orderRef: cell(row.raw, "Source Doc Nr"),
      orderLineRef: null,
      rawSku: null,
    })
  }

  return { transactions, settlements: [], payouts: [], issues }
}
