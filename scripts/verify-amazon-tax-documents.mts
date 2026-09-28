/**
 * The Amazon VAT tax invoice / credit note adapter -- offline, on made-up text.
 *
 * Run with:  npm run test:amazon-tax-documents
 *
 * The text below is INVENTED. It copies the real documents' shape (verified
 * against four real Souq.com FZ LLC PDFs for August 2026 -- see DECISIONS.md,
 * 2026-09-28) but no real invoice number, amount or business name. The
 * owner's real files are never copied into the repository.
 */

import type { MappingRuleSummary, SourceRow } from "../src/services/marketplaces/contract"
import { buildLedgerFilePayload } from "../src/services/marketplaces/ledger-file"
import { createAdapterRegistry } from "../src/services/marketplaces/registry"
import {
  amazonAdapter,
} from "../src/services/marketplaces/amazon/adapter"
import { AMAZON_V2_FORMAT_ID } from "../src/services/marketplaces/amazon/flat-file-v2"
import {
  AMAZON_TAX_CREDIT_NOTE_FORMAT_ID,
  AMAZON_TAX_DOC_FEE_KINDS,
  AMAZON_TAX_INVOICE_FORMAT_ID,
  amazonTaxCreditNoteFormat,
  amazonTaxDocMatchKey,
  amazonTaxInvoiceFormat,
  normalizeAmazonTaxDocument,
} from "../src/services/marketplaces/amazon/tax-documents"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`)
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

/* ---- invented fixture text, shaped exactly like the real PDF extraction -- */

const INVOICE_TEXT = `



TAX INVOICE
Page 1 of 1
Invoice Issue Date:30/09/2026
Invoice Period:01/09/2026 to 30/09/2026
Invoice Number:AE-TEST-INV-2026-000001
 Business Name:
FIXTURE TRADING L.L.C
 Business Address:
Fixture Street
Dubai
AE
VAT Registration Number:
100000000000001
 Supplier Name:
Souq.com FZ LLC
 Supplier Address:
DP Headquarters, Floor 3, ZoneC-FL3
Dubai Internet City
Dubai, 500255
United Arab Emirates
VAT Registration Number:100483307300003
Date of transactionDescription
Price
(Excl. Tax)
VAT RateVATTotal Price
01/09/2026Sales CommissionAED 20.005.00%AED 1.00AED 21.00
02/09/2026Paid Services FeeAED 100.005.00%AED 5.00AED 105.00
03/09/2026A Brand New Fee BizMind Has Never SeenAED 10.005.00%AED 0.50AED 10.50
TOTALAED 130.00

AED 6.50AED 136.50
Please note that this invoice is not a demand for payment.
Souq.com FZ LLC, DP Headquarters, Floor 3, ZoneC-FL3, Dubai Internet City, Dubai, United Arab
Emirates.
Commercial license number: 17646
VAT Number: 100483307300003`

const CREDIT_NOTE_TEXT = `



TAX CREDIT NOTE
Page 1 of 1
Credit Note Issue Date:  30/09/2026
Credit Note Number:  AE-TEST-CN-2026-000001
 Business Name:
FIXTURE TRADING L.L.C
 Business Address:
Fixture Street
Dubai
AE
VAT Registration Number:
100000000000001
 Supplier Name:
Souq.com FZ LLC
 Supplier Address:
DP Headquarters, Floor 3, ZoneC-FL3
Dubai Internet City
Dubai, 500255
United Arab Emirates
VAT Registration Number:  100483307300003
Reason for Credit:  Agreed price adjustment
Original Transaction Date
with Invoice Number & Date
Transaction
Date
Description
Price
(Excl. Tax)
VAT
Rate
VAT
Total
Price
01/09/2026
AE-TEST-INV-2026-000000
30/09/2026
05/09/2026
 Sales Commission
Original Charge
Adjustment Made
Revised transaction detail
AED 40.00
-AED 15.00
AED 25.00
5.00%
5.00%
5.00%
AED 2.00
-AED 0.75
AED 1.25
AED 42.00
-AED 15.75
AED 26.25
02/09/2026
AE-TEST-INV-2026-000000
30/09/2026
06/09/2026
 Shipping Chargeback
Original Charge
Adjustment Made
Revised transaction detail
AED 9.52
-AED 9.52
AED 0.00
5.00%
5.00%
5.00%
AED 0.48
-AED 0.48
AED 0.00
AED 10.00
-AED 10.00
AED 0.00
Total Adjustments-AED 25.75

-AED 1.23-AED 26.98
Please note that this credit note is not a demand for payment.
Souq.com FZ LLC, DP Headquarters, Floor 3, ZoneC-FL3, Dubai Internet City, Dubai, United Arab Emirates.
Commercial license number: 17646
VAT Number: 100483307300003`

/** The rules the migration seeds, built the same way the migration builds them. */
function rulesFor(sourceType: "TaxInvoice" | "TaxCreditNote"): MappingRuleSummary[] {
  const rules: MappingRuleSummary[] = []
  let n = 0
  for (const kind of AMAZON_TAX_DOC_FEE_KINDS) {
    n += 1
    rules.push({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      matchKey: amazonTaxDocMatchKey(sourceType, "FeeExclTax", kind.description),
      side: "MEMO",
      category: "INFORMATIONAL",
      subcategory: `${kind.slug}_excl_vat`,
      attribution: "MARKETPLACE",
      quantityRule: "NONE",
      signRule: "NEGATE",
    })
    n += 1
    rules.push({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      matchKey: amazonTaxDocMatchKey(sourceType, "VAT", kind.description),
      side: kind.vatAlreadyInSettlement ? "MEMO" : "TAX",
      category: kind.vatAlreadyInSettlement ? "INFORMATIONAL" : "FEE_VAT",
      subcategory: `${kind.slug}_vat`,
      attribution: "MARKETPLACE",
      quantityRule: "NONE",
      signRule: "NEGATE",
    })
  }
  return rules
}

const invoiceRules = rulesFor("TaxInvoice")
const creditNoteRules = rulesFor("TaxCreditNote")

const row = (text: string): SourceRow => ({ rowNumber: 2, raw: { text } })

/* -------------------------------------------------------------------------- */
section("1. RECOGNISING THE FILE")

const registry = createAdapterRegistry()
registry.register(amazonAdapter)

const invoiceDetection = registry.detect({ fileName: "invoice.pdf", headers: ["text"], rows: [[INVOICE_TEXT]] })
check(
  "a tax invoice PDF is recognised as amazon.tax_invoice",
  invoiceDetection.kind === "match" && invoiceDetection.format.id === AMAZON_TAX_INVOICE_FORMAT_ID,
  JSON.stringify(invoiceDetection)
)

const creditNoteDetection = registry.detect({ fileName: "cn.pdf", headers: ["text"], rows: [[CREDIT_NOTE_TEXT]] })
check(
  "a tax credit note PDF is recognised as amazon.tax_credit_note",
  creditNoteDetection.kind === "match" && creditNoteDetection.format.id === AMAZON_TAX_CREDIT_NOTE_FORMAT_ID,
  JSON.stringify(creditNoteDetection)
)

const settlementStillDetects = registry.detect({
  fileName: "settlement.txt",
  headers: ["settlement-id", "transaction-type", "amount-type", "amount-description", "amount"],
  rows: [],
})
check(
  "the settlement format is untouched: still unknown on a 5-header sample (it needs all 24)",
  settlementStillDetects.kind === "unknown"
)

const unrelatedPdf = registry.detect({ fileName: "other.pdf", headers: ["text"], rows: [["Some other document entirely, not Amazon's."]] })
check("an unrelated PDF is not misdetected as a tax document", unrelatedPdf.kind === "unknown")

/* -------------------------------------------------------------------------- */
section("2. TAX INVOICE: EVERY LINE, EXCL-TAX INFORMATIONAL AND VAT SIDE BY SIDE")

const invoiceResult = normalizeAmazonTaxDocument({
  formatId: AMAZON_TAX_INVOICE_FORMAT_ID,
  rows: [row(INVOICE_TEXT)],
  account: { id: "acct-1", marketplaceCode: "AMAZON", currency: "AED" },
  rules: invoiceRules,
})

check("one source row in, six transactions out (3 lines x 2 each)", invoiceResult.transactions.length === 6, String(invoiceResult.transactions.length))

const commissionExclVat = invoiceResult.transactions.find((t) => t.sourceDescription === "Sales Commission" && t.sourceSubtype === "FeeExclTax")
const commissionVat = invoiceResult.transactions.find((t) => t.sourceDescription === "Sales Commission" && t.sourceSubtype === "VAT")
check(
  "Sales Commission's fee (excl. VAT) is INFORMATIONAL, never counted, and negated like every other fee",
  commissionExclVat?.side === "MEMO" && commissionExclVat?.category === "INFORMATIONAL" && commissionExclVat?.amount === "-20.00",
  JSON.stringify(commissionExclVat)
)
check(
  "Sales Commission's VAT is a genuinely new FEE_VAT line, negated like the settlement's own VAT lines",
  commissionVat?.side === "TAX" && commissionVat?.category === "FEE_VAT" && commissionVat?.amount === "-1.00",
  JSON.stringify(commissionVat)
)
check(
  "both carry the invoice number as external_ref, and the transaction's own date",
  commissionVat?.externalRef === "AE-TEST-INV-2026-000001" && commissionVat?.postedAt === "2026-09-01T00:00:00Z",
  JSON.stringify(commissionVat)
)

const paidServicesExclVat = invoiceResult.transactions.find((t) => t.sourceDescription === "Paid Services Fee" && t.sourceSubtype === "FeeExclTax")
const paidServicesVat = invoiceResult.transactions.find((t) => t.sourceDescription === "Paid Services Fee" && t.sourceSubtype === "VAT")
check(
  "Paid Services Fee: BOTH its fee and its VAT are INFORMATIONAL -- the settlement already counts both (migration 0044)",
  paidServicesExclVat?.category === "INFORMATIONAL" && paidServicesVat?.category === "INFORMATIONAL" && paidServicesVat?.side === "MEMO",
  JSON.stringify({ paidServicesExclVat, paidServicesVat })
)

const unknownFeeVat = invoiceResult.transactions.find((t) => t.sourceDescription === "A Brand New Fee BizMind Has Never Seen" && t.sourceSubtype === "VAT")
check(
  "an unrecognised fee description is kept as UNMAPPED with a warning, never dropped",
  unknownFeeVat?.category === "UNMAPPED" && unknownFeeVat?.mappingRuleId === null,
  JSON.stringify(unknownFeeVat)
)
check(
  "a warning issue names the unrecognised description",
  invoiceResult.issues.some((i) => i.severity === "WARNING" && i.message.includes("A Brand New Fee BizMind Has Never Seen")),
  JSON.stringify(invoiceResult.issues)
)
check("the TOTAL line is not read as a data row", !invoiceResult.transactions.some((t) => t.sourceDescription?.startsWith("TOTAL")))

/* -------------------------------------------------------------------------- */
section("3. TAX CREDIT NOTE: ONLY 'ADJUSTMENT MADE' BECOMES A TRANSACTION")

const cnResult = normalizeAmazonTaxDocument({
  formatId: AMAZON_TAX_CREDIT_NOTE_FORMAT_ID,
  rows: [row(CREDIT_NOTE_TEXT)],
  account: { id: "acct-1", marketplaceCode: "AMAZON", currency: "AED" },
  rules: creditNoteRules,
})

check("two adjustment blocks in, four transactions out (2 blocks x 2 each)", cnResult.transactions.length === 4, String(cnResult.transactions.length))

const commissionAdjExclVat = cnResult.transactions.find((t) => t.sourceDescription === "Sales Commission" && t.sourceSubtype === "FeeExclTax")
const commissionAdjVat = cnResult.transactions.find((t) => t.sourceDescription === "Sales Commission" && t.sourceSubtype === "VAT")
check(
  "the adjustment DELTA is used, not the original charge or the revised total -- and a reduction " +
    "(printed negative) negates to positive, partly reversing the fee's negative total",
  commissionAdjExclVat?.amount === "15.00" && commissionAdjVat?.amount === "0.75",
  JSON.stringify({ commissionAdjExclVat, commissionAdjVat })
)
check(
  "the credit note's own number is the external_ref, and its own adjustment date is posted_at",
  commissionAdjVat?.externalRef === "AE-TEST-CN-2026-000001" && commissionAdjVat?.postedAt === "2026-09-05T00:00:00Z",
  JSON.stringify(commissionAdjVat)
)

const shippingAdjExclVat = cnResult.transactions.find((t) => t.sourceDescription === "Shipping Chargeback" && t.sourceSubtype === "FeeExclTax")
check("a zero revised total does not confuse the block reader: the adjustment (printed -9.52, negated to 9.52) is still read", shippingAdjExclVat?.amount === "9.52", JSON.stringify(shippingAdjExclVat))
check("the 'Total Adjustments' summary line is not read as a block", cnResult.transactions.length === 4)

/* -------------------------------------------------------------------------- */
section("4. A DOCUMENT WITH NO READABLE LINES IS AN ERROR, NOT A SILENT DROP")

const empty = normalizeAmazonTaxDocument({
  formatId: AMAZON_TAX_INVOICE_FORMAT_ID,
  rows: [row("Not a tax invoice at all.")],
  account: { id: "acct-1", marketplaceCode: "AMAZON", currency: "AED" },
  rules: invoiceRules,
})
check(
  "zero transactions, but the source row is accounted for by an ERROR issue",
  empty.transactions.length === 0 && empty.issues.some((i) => i.severity === "ERROR" && i.rowNumber === 2),
  JSON.stringify(empty.issues)
)

/* -------------------------------------------------------------------------- */
section("5. THE RESULT IS A FILE THE LEDGER WILL ACCEPT")

const built = buildLedgerFilePayload({
  accountId: "11111111-1111-4111-8111-111111111111",
  accountCurrency: "AED",
  format: amazonTaxInvoiceFormat,
  file: { name: "invoice.pdf", type: "pdf", sizeBytes: INVOICE_TEXT.length, sha256: "a".repeat(64) },
  columns: ["text"],
  rows: [{ rowNumber: 2, raw: { text: INVOICE_TEXT } }],
  result: invoiceResult,
})
check("buildLedgerFilePayload accepts the invoice's transactions with no problems", built.ok, built.ok ? "" : JSON.stringify((built as { problems: string[] }).problems))
if (built.ok) {
  check("file_type pdf survives the payload", built.payload.file_type === "pdf")
  check("every transaction carries external_ref through to the payload", built.payload.transactions.every((t) => t.external_ref === "AE-TEST-INV-2026-000001"))
}

const builtCn = buildLedgerFilePayload({
  accountId: "11111111-1111-4111-8111-111111111111",
  accountCurrency: "AED",
  format: amazonTaxCreditNoteFormat,
  file: { name: "cn.pdf", type: "pdf", sizeBytes: CREDIT_NOTE_TEXT.length, sha256: "b".repeat(64) },
  columns: ["text"],
  rows: [{ rowNumber: 2, raw: { text: CREDIT_NOTE_TEXT } }],
  result: cnResult,
})
check("buildLedgerFilePayload accepts the credit note's transactions with no problems", builtCn.ok, builtCn.ok ? "" : JSON.stringify((builtCn as { problems: string[] }).problems))

/* -------------------------------------------------------------------------- */
section("6. THE SETTLEMENT FORMAT AND ITS OWN NORMALIZE() ARE UNTOUCHED")

check(
  "the combined adapter still dispatches the settlement format id to the settlement reader",
  amazonAdapter.formats.some((f) => f.id === AMAZON_V2_FORMAT_ID),
)
check("the combined adapter lists all three formats", amazonAdapter.formats.length === 3, JSON.stringify(amazonAdapter.formats.map((f) => f.id)))

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log("=".repeat(74))
process.exit(failed === 0 ? 0 : 1)
