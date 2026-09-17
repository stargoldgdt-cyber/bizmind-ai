import type { DetectResult, MarketplaceAdapter, NormalizeInput, NormalizeResult } from "../contract"
import { NOON_INVOICE_HEADERS, noonInvoicesFormat, normalizeInvoices } from "./invoices"
import { NOON_INVOICES_FORMAT_ID, NOON_TV_FORMAT_ID } from "./rules"
import { NOON_TV_HEADERS, noonTransactionViewFormat, normalizeTransactionView } from "./transaction-view"

/**
 * The noon adapter (GCC Phase 5): two report formats, both from noon's seller
 * finance area, recognised by their exact column headings.
 */

const lower = (value: string) => value.trim().toLowerCase()

function hasAll(headers: Set<string>, expected: readonly string[]): boolean {
  return expected.every((header) => headers.has(lower(header)))
}

function detect(sample: { headers: readonly string[] }): DetectResult {
  const headers = new Set(sample.headers.map(lower))

  if (hasAll(headers, NOON_TV_HEADERS)) {
    return { kind: "match", formatId: NOON_TV_FORMAT_ID, confidence: headers.size > NOON_TV_HEADERS.length ? "likely" : "exact" }
  }
  if (hasAll(headers, NOON_INVOICE_HEADERS)) {
    return {
      kind: "match",
      formatId: NOON_INVOICES_FORMAT_ID,
      confidence: headers.size > NOON_INVOICE_HEADERS.length ? "likely" : "exact",
    }
  }
  return { kind: "unknown" }
}

function normalize(input: NormalizeInput): NormalizeResult {
  if (input.formatId === NOON_TV_FORMAT_ID) return normalizeTransactionView(input)
  if (input.formatId === NOON_INVOICES_FORMAT_ID) return normalizeInvoices(input)
  throw new Error(`The noon adapter does not read format ${input.formatId}.`)
}

export const noonAdapter: MarketplaceAdapter = {
  marketplace: "NOON",
  formats: [noonTransactionViewFormat, noonInvoicesFormat],
  detect,
  normalize,
}
