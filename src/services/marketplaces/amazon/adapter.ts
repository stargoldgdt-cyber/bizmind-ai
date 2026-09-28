import type { DetectResult, DetectSample, MarketplaceAdapter, NormalizeInput, NormalizeResult } from "../contract"
import { AMAZON_V2_FORMAT_ID, amazonFlatFileV2Adapter, amazonFlatFileV2Format } from "./flat-file-v2"
import {
  AMAZON_TAX_CREDIT_NOTE_FORMAT_ID,
  AMAZON_TAX_INVOICE_FORMAT_ID,
  amazonTaxCreditNoteFormat,
  amazonTaxInvoiceFormat,
  detectAmazonTaxDocument,
  normalizeAmazonTaxDocument,
} from "./tax-documents"

/**
 * The Amazon adapter: the settlement report (Flat File V2, GCC Phase 2) plus
 * the optional VAT tax invoice / credit note PDFs (GCC Phase 9 follow-up).
 * Three formats, recognised independently; a business uploads whichever it
 * has for a period.
 */

function detect(sample: DetectSample): DetectResult {
  const settlement = amazonFlatFileV2Adapter.detect(sample)
  if (settlement.kind !== "unknown") return settlement
  return detectAmazonTaxDocument(sample)
}

function normalize(input: NormalizeInput): NormalizeResult {
  if (input.formatId === AMAZON_V2_FORMAT_ID) return amazonFlatFileV2Adapter.normalize(input)
  if (input.formatId === AMAZON_TAX_INVOICE_FORMAT_ID || input.formatId === AMAZON_TAX_CREDIT_NOTE_FORMAT_ID) {
    return normalizeAmazonTaxDocument(input)
  }
  throw new Error(`The Amazon adapter does not read format ${input.formatId}.`)
}

export const amazonAdapter: MarketplaceAdapter = {
  marketplace: "AMAZON",
  formats: [amazonFlatFileV2Format, amazonTaxInvoiceFormat, amazonTaxCreditNoteFormat],
  detect,
  normalize,
}
