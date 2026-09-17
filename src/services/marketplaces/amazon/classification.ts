import type { CategoryCode } from "@/services/classification/model"

/**
 * How each Amazon Flat File V2 code is classified (owner-approved 2026-09-15),
 * restated in the four-layer model. Seeded as GLOBAL HIGH rules by migration
 * 0032; `npm run test:classification` fails if this list, the importer's
 * AMAZON_V2_RULES and the migration disagree.
 *
 * The P&L treatment comes from the category, and Input VAT follows the
 * account's VAT setting (B1).
 */
export type AmazonClassification = {
  matchKey: string
  category: CategoryCode
  subcategory: string
}

export const AMAZON_V2_CLASSIFICATION: readonly AmazonClassification[] = [
  { matchKey: "Order|ItemPrice|Principal", category: "PRODUCT_SALES", subcategory: "Principal" },
  { matchKey: "Order|ItemPrice|Shipping", category: "SHIPPING_INCOME", subcategory: "Shipping charged" },
  { matchKey: "Order|ItemPrice|COD", category: "OTHER_INCOME", subcategory: "COD charge" },
  { matchKey: "Order|ItemFees|CODFee", category: "PAYMENT_FEE", subcategory: "COD fee" },
  { matchKey: "Order|ItemFees|Commission", category: "MARKETPLACE_FEE", subcategory: "Referral commission" },
  { matchKey: "Order|ItemFees|FBAPerUnitFulfillmentFee", category: "FULFILLMENT", subcategory: "FBA per-unit fulfilment" },
  { matchKey: "Order|ItemFees|ShippingChargeback", category: "FULFILLMENT", subcategory: "Shipping chargeback" },
  { matchKey: "Order|ItemFees|VariableClosingFee", category: "MARKETPLACE_FEE", subcategory: "Variable closing fee" },
  { matchKey: "Order|Promotion|Shipping", category: "SELLER_DISCOUNTS", subcategory: "Shipping promotion" },
  { matchKey: "Refund|ItemPrice|Principal", category: "SALES_REFUNDS", subcategory: "Refunded principal" },
  { matchKey: "Refund|ItemPrice|Shipping", category: "SALES_REFUNDS", subcategory: "Refunded shipping" },
  { matchKey: "Refund|ItemPrice|COD", category: "OTHER_INCOME", subcategory: "COD charge" },
  { matchKey: "Refund|ItemFees|CODFee", category: "PAYMENT_FEE", subcategory: "COD fee" },
  { matchKey: "Refund|ItemFees|Commission", category: "MARKETPLACE_FEE", subcategory: "Referral commission" },
  { matchKey: "Refund|ItemFees|RefundCommission", category: "REFUND_FEE", subcategory: "Refund administration fee" },
  { matchKey: "Refund|ItemFees|ShippingChargeback", category: "FULFILLMENT", subcategory: "Shipping chargeback" },
  { matchKey: "Refund|Promotion|Shipping", category: "SELLER_DISCOUNTS", subcategory: "Shipping promotion" },
  { matchKey: "ServiceFee|Cost of Advertising|TransactionTotalAmount", category: "ADVERTISING", subcategory: "Sponsored ads" },
  { matchKey: "AmazonFees|Premium Services Fee|Base fee", category: "MARKETPLACE_FEE", subcategory: "SP 360 premium services" },
  { matchKey: "AmazonFees|Premium Services Fee|Tax on fee", category: "INPUT_VAT", subcategory: "VAT on SP 360 fee" },
  { matchKey: "FBAFees|FBA Inventory Storage Fee|Base fee", category: "STORAGE", subcategory: "FBA storage" },
]
