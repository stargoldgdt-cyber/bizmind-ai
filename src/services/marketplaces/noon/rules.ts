import type { CategoryCode } from "@/services/classification/model"

import type { Attribution, LedgerCategory, LedgerSide } from "../contract"

/**
 * How every noon code is read and classified (GCC Phase 5).
 *
 * Built from the owner's real July 2026 files: the Transaction View (item
 * level) and the Invoices & Credit Notes export. Migration 0034 seeds exactly
 * this list into ledger_mapping_rules (import) and classification_rules
 * (meaning); `npm run test:noon` fails if they differ.
 *
 * Each rule carries two meanings:
 *   import*      what the importer writes (the Phase 1 taxonomy)
 *   category     what the money is (the four-layer model), with confidence
 *
 * VAT. noon's Transaction View reports fees INCLUDING VAT
 * (`includesVat`). The VAT is stated only on noon's statement invoices, so
 * each invoice fee line becomes two ledger lines (`separatesVat`): the VAT
 * taken back out of the fee's category, and the same VAT as Input VAT. BizMind
 * never calculates VAT from a rate.
 */

export const NOON_TV_FORMAT_ID = "noon.transaction_view.item_level"
export const NOON_INVOICES_FORMAT_ID = "noon.invoices_credit_notes"

export type NoonRule = {
  formatId: string
  matchKey: string
  side: LedgerSide
  importCategory: LedgerCategory
  importSubcategory: string
  quantityRule: "NONE" | "REPORTED" | "COUNT_LINE"
  attribution: Attribution
  category: CategoryCode
  subcategory: string
  confidence: "HIGH" | "MEDIUM"
  includesVat: boolean
  separatesVat: boolean
  note: string
}

/** Transaction View key: transaction type | amount column | level or fee name. */
export function noonTvMatchKey(transactionType: string, column: string, detail: string): string {
  return `${transactionType}|${column}|${detail}`
}

/** Invoices key: transaction type | line role | fee name or document type. */
export function noonInvoiceMatchKey(transactionType: string, role: string, detail: string): string {
  return `${transactionType}|${role}|${detail}`
}

/* ---- Transaction View ------------------------------------------------------ */

type TvColumn = {
  column: string
  importCategory: LedgerCategory
  importSubcategory: string
  category: CategoryCode
  subcategory: string
  includesVat: boolean
  confidence: "HIGH" | "MEDIUM"
  note: string
}

export const NOON_TV_AMOUNT_COLUMNS: readonly TvColumn[] = [
  { column: "Net Proceeds", importCategory: "REVENUE", importSubcategory: "net_proceeds", category: "PRODUCT_SALES", subcategory: "Net proceeds", includesVat: false, confidence: "HIGH", note: "What the buyer paid for the item, as noon reports it." },
  { column: "Referral Fee including VAT", importCategory: "MARKETPLACE_FEE", importSubcategory: "referral_fee", category: "MARKETPLACE_FEE", subcategory: "Referral fee", includesVat: true, confidence: "HIGH", note: "noon's commission, VAT included." },
  { column: "Fullfilment & Logistics Fees including VAT", importCategory: "FULFILMENT", importSubcategory: "fulfilment_logistics", category: "FULFILLMENT", subcategory: "Fulfilment and logistics", includesVat: true, confidence: "HIGH", note: "FBN and Directship outbound fees and their rebates, VAT included." },
  { column: "Shipping Credits including VAT", importCategory: "REVENUE", importSubcategory: "shipping_credits", category: "SHIPPING_INCOME", subcategory: "Shipping credits", includesVat: false, confidence: "MEDIUM", note: "Shipping credited to the seller." },
  { column: "Other Order Fees including VAT", importCategory: "MARKETPLACE_FEE", importSubcategory: "other_order_fees", category: "MARKETPLACE_FEE", subcategory: "Other order fees", includesVat: true, confidence: "MEDIUM", note: "Return administration and cancellation fees, VAT included; one column, so under review." },
  { column: "Order Subsidies including VAT", importCategory: "SUBSIDY", importSubcategory: "order_subsidies", category: "SUBSIDY_INCOME", subcategory: "Order subsidies", includesVat: false, confidence: "HIGH", note: "noon-funded subsidies credited to the seller." },
  { column: "Non-Order Fees including VAT", importCategory: "MARKETPLACE_FEE", importSubcategory: "non_order_fees", category: "MARKETPLACE_FEE", subcategory: "Non-order fees", includesVat: true, confidence: "MEDIUM", note: "Fees not tied to an order line, such as the warranty fee." },
  { column: "Non-Order Subsidies including VAT", importCategory: "SUBSIDY", importSubcategory: "non_order_subsidies", category: "SUBSIDY_INCOME", subcategory: "Non-order subsidies", includesVat: false, confidence: "MEDIUM", note: "Subsidies not tied to an order line." },
]

/** Every money column of the Transaction View except the row total. */
export const NOON_TV_PART_COLUMNS: readonly string[] = [
  ...NOON_TV_AMOUNT_COLUMNS.map((c) => c.column),
  "Others including VAT",
]

function tvOrderRules(): NoonRule[] {
  const rules: NoonRule[] = []
  for (const transactionType of ["order", "order_update"] as const) {
    for (const level of ["item", "order"] as const) {
      for (const c of NOON_TV_AMOUNT_COLUMNS) {
        const isUpdateProceeds = transactionType === "order_update" && c.column === "Net Proceeds"
        rules.push({
          formatId: NOON_TV_FORMAT_ID,
          matchKey: noonTvMatchKey(transactionType, c.column, level),
          side: "PNL",
          importCategory: c.importCategory,
          importSubcategory: transactionType === "order" ? c.importSubcategory : `${c.importSubcategory}_update`,
          quantityRule: transactionType === "order" && level === "item" && c.column === "Net Proceeds" ? "COUNT_LINE" : "NONE",
          attribution: level === "item" ? "ORDER_LINE" : "ORDER",
          category: c.category,
          subcategory: isUpdateProceeds ? "Order updates" : c.subcategory,
          confidence: isUpdateProceeds ? "MEDIUM" : c.confidence,
          includesVat: c.includesVat,
          separatesVat: false,
          note: isUpdateProceeds
            ? "Returns and later changes to an order; the sign shows the direction. Counted with sales, under review."
            : c.note,
        })
      }
    }
  }
  return rules
}

const TV_OTHER_RULES: NoonRule[] = [
  { formatId: NOON_TV_FORMAT_ID, matchKey: noonTvMatchKey("statement_fee", "Non-Order Fees including VAT", "Advertising Fee"), side: "PNL", importCategory: "ADVERTISING", importSubcategory: "advertising_fee", quantityRule: "NONE", attribution: "MARKETPLACE", category: "ADVERTISING", subcategory: "Advertising fee", confidence: "HIGH", includesVat: true, separatesVat: false, note: "noon advertising charged on the statement, VAT included; matches the invoices exactly." },
  { formatId: NOON_TV_FORMAT_ID, matchKey: noonTvMatchKey("payment", "Others including VAT", "Payment Disbursal"), side: "CASH", importCategory: "PAYOUT", importSubcategory: "payment_disbursal", quantityRule: "NONE", attribution: "MARKETPLACE", category: "PAYOUT", subcategory: "Payment disbursal", confidence: "HIGH", includesVat: false, separatesVat: false, note: "A bank transfer noon reports sending. Never revenue." },
  { formatId: NOON_TV_FORMAT_ID, matchKey: noonTvMatchKey("balance_transfer", "Others including VAT", ""), side: "CASH", importCategory: "TRANSFER", importSubcategory: "balance_transfer", quantityRule: "NONE", attribution: "MARKETPLACE", category: "TRANSFER", subcategory: "Balance transfer", confidence: "MEDIUM", includesVat: false, separatesVat: false, note: "A transfer between noon balances; purpose not stated in the file, so under review (B4)." },
]

/* ---- Invoices & Credit Notes ---------------------------------------------- */

type InvoiceFee = {
  fee: string
  importCategory: LedgerCategory
  category: CategoryCode
  confidence: "HIGH" | "MEDIUM"
  /** The whole amount is VAT (import VAT recovered by noon). */
  wholeAmountIsVat?: boolean
}

export const NOON_INVOICE_FEES: readonly InvoiceFee[] = [
  { fee: "Referral Fee", importCategory: "MARKETPLACE_FEE", category: "MARKETPLACE_FEE", confidence: "HIGH" },
  { fee: "Referral Fee Adjustment", importCategory: "MARKETPLACE_FEE", category: "MARKETPLACE_FEE", confidence: "HIGH" },
  { fee: "Directship Outbound Fee", importCategory: "FULFILMENT", category: "FULFILLMENT", confidence: "HIGH" },
  { fee: "FBN Outbound Fee", importCategory: "FULFILMENT", category: "FULFILLMENT", confidence: "HIGH" },
  { fee: "Rebates & Discounts (Directship Outbound Fee)", importCategory: "FULFILMENT", category: "FULFILLMENT", confidence: "HIGH" },
  { fee: "Shipping Fee Rebate", importCategory: "FULFILMENT", category: "FULFILLMENT", confidence: "MEDIUM" },
  { fee: "Advertising Fee", importCategory: "ADVERTISING", category: "ADVERTISING", confidence: "HIGH" },
  { fee: "Return Administration Fee", importCategory: "MARKETPLACE_FEE", category: "MARKETPLACE_FEE", confidence: "MEDIUM" },
  { fee: "Cancellation Fee", importCategory: "MARKETPLACE_FEE", category: "MARKETPLACE_FEE", confidence: "MEDIUM" },
  { fee: "Damaged Returns Fee", importCategory: "FULFILMENT", category: "FULFILLMENT", confidence: "MEDIUM" },
  { fee: "Warranty Fee", importCategory: "MARKETPLACE_FEE", category: "MARKETPLACE_FEE", confidence: "MEDIUM" },
  { fee: "Import VAT Recovery", importCategory: "FULFILMENT", category: "FULFILLMENT", confidence: "MEDIUM", wholeAmountIsVat: true },
]

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")

function invoiceFeeRules(): NoonRule[] {
  return NOON_INVOICE_FEES.flatMap((f) => [
    {
      formatId: NOON_INVOICES_FORMAT_ID,
      matchKey: noonInvoiceMatchKey("Statement Fee", "vat_included", f.fee),
      side: "PNL",
      importCategory: f.importCategory,
      importSubcategory: `vat_in_${slug(f.fee)}`.slice(0, 80),
      quantityRule: "NONE",
      attribution: "MARKETPLACE",
      category: f.category,
      subcategory: f.wholeAmountIsVat ? "Import VAT charged within fees" : `VAT included in ${f.fee}`,
      confidence: f.confidence,
      includesVat: false,
      separatesVat: true,
      note: f.wholeAmountIsVat
        ? "Import VAT noon recovered from the seller, charged within the fees; taken out of fees and shown as input VAT."
        : `The VAT noon charged on ${f.fee}, taken back out of the fee so the fee shows without VAT.`,
    },
    {
      formatId: NOON_INVOICES_FORMAT_ID,
      matchKey: noonInvoiceMatchKey("Statement Fee", "input_vat", f.fee),
      side: "TAX",
      importCategory: "FEE_VAT",
      importSubcategory: `vat_${slug(f.fee)}`.slice(0, 80),
      quantityRule: "NONE",
      attribution: "MARKETPLACE",
      category: "INPUT_VAT",
      subcategory: f.wholeAmountIsVat ? "Import VAT recovered by noon" : `VAT on ${f.fee}`,
      confidence: f.confidence,
      includesVat: false,
      separatesVat: true,
      note: "Input VAT as stated on noon's statement invoice; its P&L effect follows the account VAT setting (B1).",
    },
  ])
}

const CUSTOMER_RULES: NoonRule[] = [
  { formatId: NOON_INVOICES_FORMAT_ID, matchKey: noonInvoiceMatchKey("Customer", "output_vat", "Invoice"), side: "TAX", importCategory: "OUTPUT_VAT", importSubcategory: "output_vat_invoice", quantityRule: "NONE", attribution: "ORDER", category: "OUTPUT_VAT", subcategory: "Output VAT on sales invoices", confidence: "HIGH", includesVat: false, separatesVat: false, note: "VAT on the sale, as noon invoiced the buyer. Tax only; sales are shown as noon reports them." },
  { formatId: NOON_INVOICES_FORMAT_ID, matchKey: noonInvoiceMatchKey("Customer", "output_vat", "Creditnote"), side: "TAX", importCategory: "OUTPUT_VAT", importSubcategory: "output_vat_credit_note", quantityRule: "NONE", attribution: "ORDER", category: "OUTPUT_VAT", subcategory: "Output VAT reversed by credit notes", confidence: "HIGH", includesVat: false, separatesVat: false, note: "VAT given back on a credit note. Tax only." },
]

export const NOON_RULES: readonly NoonRule[] = [
  ...tvOrderRules(),
  ...TV_OTHER_RULES,
  ...invoiceFeeRules(),
  ...CUSTOMER_RULES,
]
