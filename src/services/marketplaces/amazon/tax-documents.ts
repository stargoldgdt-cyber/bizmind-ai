import type {
  DetectResult,
  FormatDescriptor,
  MappingRuleSummary,
  NormalizeInput,
  NormalizeResult,
  TransactionDraft,
} from "../contract"
import { UNMAPPED } from "../contract"
import type { RowIssue } from "@/services/ingestion/contracts"

/**
 * Amazon VAT tax invoices and credit notes (GCC Phase 9 follow-up).
 *
 * Amazon's settlement report (flat-file-v2.ts) only itemises VAT for one fee
 * (the SP 360 / "Paid Services Fee" line). Every other fee — referral
 * commission, FBA fulfilment, chargebacks, closing fees — has 5% VAT that
 * Amazon charges but never puts in the settlement; it only appears on a
 * separate monthly tax invoice (a PDF, confirmed with the owner — Amazon
 * Seller Central offers no CSV/Excel export of these documents). Built
 * against four real Souq.com FZ LLC documents for August 2026 supplied by
 * the owner: two tax invoices (AE-SFZL-INV-2026-505434, -505435) and two
 * credit notes (AE-SFZL-CN-2026-194286, -199612). See DECISIONS.md
 * (2026-09-28).
 *
 * WHAT THE REAL DOCUMENTS TAUGHT, AND THIS CODE RELIES ON
 * ---------------------------------------------------------
 *   - Every fee amount printed on these documents is Amazon's OWN restatement
 *     of a fee already recorded through the settlement (its "Price (Excl.
 *     Tax)" column reconciles to the settlement's fee lines). Recording it
 *     again as a marketplace fee would double the fee, not just add VAT. So
 *     only the VAT column ever becomes a new P&L-affecting transaction; the
 *     fee-excl-tax column is kept (for traceability) but classified
 *     INFORMATIONAL — never counted. This applies to EVERY row.
 *   - "Paid Services Fee" is the one exception in the other direction: the
 *     settlement already reports this fee WITH its VAT included in one line
 *     (migration 0044). So for this description alone, both the fee and the
 *     VAT from the tax document are informational duplicates.
 *   - A credit note shows three numbers per line — "Original Charge",
 *     "Adjustment Made", "Revised transaction detail" — for each of price,
 *     rate, VAT and total. Only "Adjustment Made" is a new fact; the other
 *     two are the invoice already recorded and their arithmetic sum.
 *   - One PDF is one document, not a table of independent rows (there is no
 *     natural "row" in a PDF the way there is in a CSV). parse.ts hands the
 *     whole extracted text over as a single source row; this adapter finds
 *     every line/block inside it and emits several transactions from that one
 *     row (`lineIndex` exists for exactly this).
 *
 * PURE. Text in, drafts out. Never writes, never converts a currency, never
 * does arithmetic on money: every amount stays exactly the text the document
 * printed.
 */

export const AMAZON_TAX_INVOICE_FORMAT_ID = "amazon.tax_invoice"
export const AMAZON_TAX_CREDIT_NOTE_FORMAT_ID = "amazon.tax_credit_note"
export const AMAZON_TAX_DOC_ADAPTER_VERSION = "1.0.0"

export const amazonTaxInvoiceFormat: FormatDescriptor = {
  id: AMAZON_TAX_INVOICE_FORMAT_ID,
  label: "Amazon VAT tax invoice (PDF)",
  adapterVersion: AMAZON_TAX_DOC_ADAPTER_VERSION,
  requiredHeaders: ["text"],
  allowedColumns: ["text"],
}

export const amazonTaxCreditNoteFormat: FormatDescriptor = {
  id: AMAZON_TAX_CREDIT_NOTE_FORMAT_ID,
  label: "Amazon VAT tax credit note (PDF)",
  adapterVersion: AMAZON_TAX_DOC_ADAPTER_VERSION,
  requiredHeaders: ["text"],
  allowedColumns: ["text"],
}

/**
 * Every fee description the owner's real documents showed, and the subcategory
 * each one's VAT and fee-excl-tax lines are seeded under (matches the migration
 * that seeds `ledger_mapping_rules` and `classification_rules` verbatim — a
 * test fails if they differ, exactly as AMAZON_V2_RULES in flat-file-v2.ts).
 *
 * `vatAlreadyInSettlement`: true only for "Paid Services Fee", whose VAT the
 * settlement already reports on its own combined line (migration 0044). For
 * every other description, the VAT here is genuinely new.
 */
export type AmazonTaxDocFeeKind = {
  description: string
  slug: string
  vatAlreadyInSettlement: boolean
}

export const AMAZON_TAX_DOC_FEE_KINDS: readonly AmazonTaxDocFeeKind[] = [
  { description: "Sales Commission", slug: "referral", vatAlreadyInSettlement: false },
  { description: "Refund Commission", slug: "refund_administration", vatAlreadyInSettlement: false },
  { description: "Variable Closing Fee", slug: "closing", vatAlreadyInSettlement: false },
  { description: "Multitier Per Unit Fee", slug: "multitier_per_unit", vatAlreadyInSettlement: false },
  { description: "Shipping Chargeback", slug: "shipping_chargeback", vatAlreadyInSettlement: false },
  { description: "COD Chargeback Fee", slug: "cod", vatAlreadyInSettlement: false },
  { description: "Paid Services Fee", slug: "premium_services", vatAlreadyInSettlement: true },
]

/** `sourceType|sourceSubtype|sourceDescription`, matching `classification_match_key()`. */
export function amazonTaxDocMatchKey(sourceType: string, sourceSubtype: string, description: string): string {
  return `${sourceType}|${sourceSubtype}|${description}`
}

const FEE_KIND_BY_DESCRIPTION = new Map(AMAZON_TAX_DOC_FEE_KINDS.map((kind) => [kind.description, kind]))

/* ---- detection ------------------------------------------------------------ */

function detect(sample: { headers: readonly string[]; rows: readonly (readonly string[])[] }): DetectResult {
  const headers = new Set(sample.headers.map((h) => h.trim().toLowerCase()))
  if (headers.size !== 1 || !headers.has("text")) return { kind: "unknown" }

  const text = sample.rows[0]?.[0] ?? ""
  if (text.includes("TAX CREDIT NOTE") && text.includes("Souq.com FZ LLC")) {
    return { kind: "match", formatId: AMAZON_TAX_CREDIT_NOTE_FORMAT_ID, confidence: "exact" }
  }
  if (text.includes("TAX INVOICE") && text.includes("Souq.com FZ LLC")) {
    return { kind: "match", formatId: AMAZON_TAX_INVOICE_FORMAT_ID, confidence: "exact" }
  }
  return { kind: "unknown" }
}

/* ---- values ---------------------------------------------------------------- */

const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/

/** A document date (`DD/MM/YYYY`, no time) as an instant at midnight UTC. */
function parseDocumentDate(value: string): string | null {
  const match = DATE.exec(value)
  if (!match) return null
  const [, dd, mm, yyyy] = match
  const probe = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)))
  if (probe.getUTCFullYear() !== Number(yyyy) || probe.getUTCMonth() !== Number(mm) - 1 || probe.getUTCDate() !== Number(dd)) {
    return null
  }
  return `${yyyy}-${mm}-${dd}T00:00:00Z`
}

type FeeLine = { date: string; description: string; currency: string; priceExclTax: string; vat: string }

const INVOICE_LINE =
  /^(\d{2}\/\d{2}\/\d{4})([A-Za-z][A-Za-z ]*?)([A-Z]{3}) ([\d,]+\.\d{2})(?:\d+\.\d{2})%[A-Z]{3} ([\d,]+\.\d{2})[A-Z]{3} [\d,]+\.\d{2}$/gm

function readInvoiceLines(text: string): FeeLine[] {
  const lines: FeeLine[] = []
  for (const match of text.matchAll(INVOICE_LINE)) {
    const [, date, description, currency, priceExclTax, vat] = match
    lines.push({ date, description: description.trim(), currency, priceExclTax, vat })
  }
  return lines
}

/**
 * One "Adjustment Made" line from a credit note's 20-line block: original
 * transaction date, the original invoice it corrects, this adjustment's own
 * date, the fee description, and the adjustment's price-excl-tax and VAT
 * deltas (as printed — negative text, never negated here).
 */
type CreditNoteAdjustment = {
  originalDate: string
  originalInvoiceNumber: string
  adjustmentDate: string
  description: string
  currency: string
  priceExclTaxDelta: string
  vatDelta: string
}

const CN_BLOCK = new RegExp(
  [
    String.raw`(\d{2}\/\d{2}\/\d{4})[ \t]*\n`, // 1 original transaction date
    String.raw`(\S+)[ \t]*\n`, // 2 original invoice number
    String.raw`\d{2}\/\d{2}\/\d{4}[ \t]*\n`, // original invoice date (unused)
    String.raw`(\d{2}\/\d{2}\/\d{4})[ \t]*\n`, // 3 this adjustment's date
    String.raw`[ \t]*([A-Za-z][A-Za-z ]*?)[ \t]*\n`, // 4 description
    String.raw`Original Charge[ \t]*\n`,
    String.raw`Adjustment Made[ \t]*\n`,
    String.raw`Revised transaction detail[ \t]*\n`,
    String.raw`[A-Z]{3} [\d,]+\.\d{2}[ \t]*\n`, // original price excl tax (unused)
    String.raw`(-?)([A-Z]{3}) ([\d,]+\.\d{2})[ \t]*\n`, // 5,6,7 adjustment price excl tax (sign, currency, amount)
    String.raw`[A-Z]{3} [\d,]+\.\d{2}[ \t]*\n`, // revised price excl tax (unused)
    String.raw`[\d.]+%[ \t]*\n`, // rate ×3 (unused)
    String.raw`[\d.]+%[ \t]*\n`,
    String.raw`[\d.]+%[ \t]*\n`,
    String.raw`[A-Z]{3} [\d,]+\.\d{2}[ \t]*\n`, // original vat (unused)
    String.raw`(-?)[A-Z]{3} ([\d,]+\.\d{2})[ \t]*\n`, // 8,9 adjustment vat (sign, amount)
    String.raw`[A-Z]{3} [\d,]+\.\d{2}[ \t]*\n`, // revised vat (unused)
    String.raw`[A-Z]{3} [\d,]+\.\d{2}[ \t]*\n`, // original total (unused)
    String.raw`-[A-Z]{3} [\d,]+\.\d{2}[ \t]*\n`, // adjustment total (unused)
    String.raw`[A-Z]{3} [\d,]+\.\d{2}`, // revised total (unused)
  ].join(""),
  "g"
)

function readCreditNoteAdjustments(text: string): CreditNoteAdjustment[] {
  const adjustments: CreditNoteAdjustment[] = []
  for (const match of text.matchAll(CN_BLOCK)) {
    const [, originalDate, originalInvoiceNumber, adjustmentDate, description, priceSign, currency, priceAmount, vatSign, vatAmount] =
      match
    adjustments.push({
      originalDate,
      originalInvoiceNumber,
      adjustmentDate,
      description: description.trim(),
      currency,
      priceExclTaxDelta: `${priceSign}${priceAmount}`,
      vatDelta: `${vatSign}${vatAmount}`,
    })
  }
  return adjustments
}

/* ---- normalisation ---------------------------------------------------------- */

function buildTransaction(
  rules: Map<string, MappingRuleSummary>,
  args: {
    sourceRowNumber: number
    lineIndex: number
    sourceType: string
    sourceSubtype: string
    description: string
    amount: string
    currency: string
    postedAt: string
    externalRef: string | null
  }
): TransactionDraft {
  const matchKey = amazonTaxDocMatchKey(args.sourceType, args.sourceSubtype, args.description)
  const rule = rules.get(matchKey)
  return {
    sourceRowNumber: args.sourceRowNumber,
    lineIndex: args.lineIndex,
    mappingRuleId: rule?.id ?? null,
    side: rule?.side ?? null,
    category: rule?.category ?? UNMAPPED,
    subcategory: rule?.subcategory ?? null,
    sourceType: args.sourceType,
    sourceSubtype: args.sourceSubtype,
    sourceDescription: args.description,
    amount: rule?.signRule === "NEGATE" ? negate(args.amount) : args.amount,
    currency: args.currency,
    postedAt: args.postedAt,
    orderRef: null,
    orderLineRef: null,
    rawSku: null,
    quantity: null,
    quantityBasis: null,
    attribution: rule?.attribution ?? "MARKETPLACE",
    settlementRef: null,
    payoutRef: null,
    externalRef: args.externalRef,
  }
}

function negate(value: string): string {
  if (/^-?0+(\.0+)?$/.test(value)) return value.replace(/^-/, "")
  return value.startsWith("-") ? value.slice(1) : `-${value}`
}

function normalizeTaxInvoice(input: NormalizeInput): NormalizeResult {
  const rules = new Map<string, MappingRuleSummary>(input.rules.map((rule) => [rule.matchKey, rule]))
  const transactions: TransactionDraft[] = []
  const issues: RowIssue[] = []
  const issue = (rowNumber: number, severity: "ERROR" | "WARNING", message: string) =>
    issues.push({ rowNumber, severity, message })

  for (const row of input.rows) {
    const text = row.raw.text ?? ""
    const invoiceNumber = /Invoice Number:(\S+)/.exec(text)?.[1] ?? null
    const lines = readInvoiceLines(text)

    if (lines.length === 0) {
      issue(row.rowNumber, "ERROR", "This does not read as an Amazon tax invoice BizMind recognises. No fee lines were found.")
      continue
    }
    if (invoiceNumber === null) {
      issue(row.rowNumber, "WARNING", "The invoice number could not be read, so these lines cannot be traced to it.")
    }

    let lineIndex = 0
    for (const line of lines) {
      const postedAt = parseDocumentDate(line.date)
      if (postedAt === null) {
        issue(row.rowNumber, "ERROR", `The transaction date "${line.date}" for "${line.description}" could not be read.`)
        continue
      }

      const kind = FEE_KIND_BY_DESCRIPTION.get(line.description)
      if (!kind) {
        issue(
          row.rowNumber,
          "WARNING",
          `"${line.description}" is not an Amazon tax-invoice fee BizMind recognises yet. Its VAT is kept and counted in no total until it is classified.`
        )
      }

      transactions.push(
        buildTransaction(rules, {
          sourceRowNumber: row.rowNumber,
          lineIndex: lineIndex++,
          sourceType: "TaxInvoice",
          sourceSubtype: "FeeExclTax",
          description: line.description,
          amount: line.priceExclTax,
          currency: line.currency,
          postedAt,
          externalRef: invoiceNumber,
        })
      )
      transactions.push(
        buildTransaction(rules, {
          sourceRowNumber: row.rowNumber,
          lineIndex: lineIndex++,
          sourceType: "TaxInvoice",
          sourceSubtype: "VAT",
          description: line.description,
          amount: line.vat,
          currency: line.currency,
          postedAt,
          externalRef: invoiceNumber,
        })
      )
    }
  }

  return { transactions, settlements: [], payouts: [], issues }
}

function normalizeTaxCreditNote(input: NormalizeInput): NormalizeResult {
  const rules = new Map<string, MappingRuleSummary>(input.rules.map((rule) => [rule.matchKey, rule]))
  const transactions: TransactionDraft[] = []
  const issues: RowIssue[] = []
  const issue = (rowNumber: number, severity: "ERROR" | "WARNING", message: string) =>
    issues.push({ rowNumber, severity, message })

  for (const row of input.rows) {
    const text = row.raw.text ?? ""
    const creditNoteNumber = /Credit Note Number:\s*(\S+)/.exec(text)?.[1] ?? null
    const adjustments = readCreditNoteAdjustments(text)

    if (adjustments.length === 0) {
      issue(row.rowNumber, "ERROR", "This does not read as an Amazon tax credit note BizMind recognises. No adjustment lines were found.")
      continue
    }
    if (creditNoteNumber === null) {
      issue(row.rowNumber, "WARNING", "The credit note number could not be read, so these lines cannot be traced to it.")
    }

    let lineIndex = 0
    for (const adj of adjustments) {
      const postedAt = parseDocumentDate(adj.adjustmentDate)
      if (postedAt === null) {
        issue(row.rowNumber, "ERROR", `The adjustment date "${adj.adjustmentDate}" for "${adj.description}" could not be read.`)
        continue
      }

      const kind = FEE_KIND_BY_DESCRIPTION.get(adj.description)
      if (!kind) {
        issue(
          row.rowNumber,
          "WARNING",
          `"${adj.description}" is not an Amazon tax-document fee BizMind recognises yet. Its VAT adjustment is kept and counted in no total until it is classified.`
        )
      }

      transactions.push(
        buildTransaction(rules, {
          sourceRowNumber: row.rowNumber,
          lineIndex: lineIndex++,
          sourceType: "TaxCreditNote",
          sourceSubtype: "FeeExclTax",
          description: adj.description,
          amount: adj.priceExclTaxDelta,
          currency: adj.currency,
          postedAt,
          externalRef: creditNoteNumber,
        })
      )
      transactions.push(
        buildTransaction(rules, {
          sourceRowNumber: row.rowNumber,
          lineIndex: lineIndex++,
          sourceType: "TaxCreditNote",
          sourceSubtype: "VAT",
          description: adj.description,
          amount: adj.vatDelta,
          currency: adj.currency,
          postedAt,
          externalRef: creditNoteNumber,
        })
      )
    }
  }

  return { transactions, settlements: [], payouts: [], issues }
}

export function detectAmazonTaxDocument(sample: { headers: readonly string[]; rows: readonly (readonly string[])[] }): DetectResult {
  return detect(sample)
}

export function normalizeAmazonTaxDocument(input: NormalizeInput): NormalizeResult {
  if (input.formatId === AMAZON_TAX_INVOICE_FORMAT_ID) return normalizeTaxInvoice(input)
  if (input.formatId === AMAZON_TAX_CREDIT_NOTE_FORMAT_ID) return normalizeTaxCreditNote(input)
  throw new Error(`The Amazon tax-document reader does not read format ${input.formatId}.`)
}
