import type { EntityDef, EntityKey } from "./contracts"

/**
 * Canonical target fields, per entity.
 *
 * These describe BizMind's own shape, not any vendor's. A Shopify connector
 * will map onto exactly these keys, which is what stops marketplace-specific
 * assumptions leaking into the data model.
 *
 * `importance` is set from what each field actually unlocks:
 *   revenue          needs total
 *   COGS             needs unit_cost (per line, or from the product catalogue)
 *   channel fees     needs fee_total
 *   gross profit     needs all three
 *   net profit       needs expenses as well
 *   inventory        needs sku and stock
 *   customers        needs customer_email
 */

const ORDERS: EntityDef = {
  key: "ORDERS",
  label: "Sales / Orders",
  description:
    "One row per order line. Order details may repeat across the lines of the same order.",
  unlocks: ["Revenue", "Gross profit", "Channel margin", "Customers", "Average order value"],
  fields: [
    {
      key: "external_id",
      label: "Order ID",
      importance: "required",
      type: "text",
      scope: "order",
      help: "The order's own reference in the system it came from.",
      consequence:
        "Without it, re-importing the same file would create duplicate orders instead of updating them.",
      aliases: ["order id", "orderid", "order_id", "order reference", "order ref", "id", "name", "transaction id"],
    },
    {
      key: "placed_at",
      label: "Order date",
      importance: "required",
      type: "date",
      scope: "order",
      help: "When the order was placed.",
      aliases: ["order date", "date", "created at", "created_at", "purchase date", "placed at", "order datetime", "paid at"],
    },
    {
      key: "total",
      label: "Order total",
      importance: "required",
      type: "money",
      scope: "order",
      help: "What the customer paid in total for this order.",
      aliases: ["total", "order total", "grand total", "amount", "total amount", "total price", "order amount"],
    },
    {
      key: "fee_total",
      label: "Channel fees",
      importance: "recommended",
      type: "money",
      scope: "order",
      help: "Marketplace commission, payment processing and fulfilment charges.",
      consequence:
        "Without fees, profit and margin will be OVERSTATED. This is usually the single biggest reason marketplace revenue is worth less than it looks.",
      aliases: ["fee", "fees", "fee total", "commission", "marketplace fee", "selling fee", "platform fee", "payment fee", "charges"],
    },
    {
      key: "quantity",
      label: "Quantity",
      importance: "recommended",
      type: "number",
      scope: "line",
      help: "Units sold on this line.",
      consequence: "Without quantity, cost of goods cannot be calculated, so profit will be overstated.",
      aliases: ["quantity", "qty", "units", "item quantity", "quantity ordered", "count"],
    },
    {
      key: "unit_cost",
      label: "Unit cost",
      importance: "recommended",
      type: "money",
      scope: "line",
      help: "What one unit cost you to buy or make, at the time of this sale.",
      consequence:
        "Without cost, profit and margin will be OVERSTATED. It can also come from a product import instead.",
      aliases: ["unit cost", "cost", "cost price", "cogs", "buy price", "purchase price", "item cost", "cost per unit"],
    },
    {
      key: "sku",
      label: "SKU",
      importance: "recommended",
      type: "text",
      scope: "line",
      help: "Product code for this line.",
      consequence:
        "Without a SKU, order lines cannot be matched to your product catalogue, so costs cannot be filled in from there.",
      aliases: ["sku", "product sku", "item sku", "product code", "item code", "variant sku", "barcode"],
    },
    {
      key: "order_number",
      label: "Order number",
      importance: "optional",
      type: "text",
      scope: "order",
      help: "The human-readable order number, if different from the ID.",
      aliases: ["order number", "order no", "order #", "invoice number", "reference"],
    },
    {
      key: "status",
      label: "Order status",
      importance: "optional",
      type: "enum",
      scope: "order",
      help: "Cancelled orders are excluded from every figure.",
      enumValues: ["PENDING", "CONFIRMED", "FULFILLED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"],
      aliases: ["status", "order status", "fulfillment status", "financial status", "state"],
    },
    {
      key: "customer_email",
      label: "Customer email",
      importance: "optional",
      type: "text",
      scope: "order",
      help: "Used to recognise repeat customers across channels.",
      consequence: "Without it, repeat-customer analytics cannot be calculated.",
      aliases: ["email", "customer email", "buyer email", "e-mail", "contact email"],
    },
    {
      key: "customer_name",
      label: "Customer name",
      importance: "optional",
      type: "text",
      scope: "order",
      aliases: ["customer", "customer name", "buyer", "buyer name", "name", "full name", "billing name"],
    },
    {
      key: "currency",
      label: "Currency",
      importance: "optional",
      type: "text",
      scope: "order",
      help: "Must match your business currency. Nothing is converted.",
      aliases: ["currency", "currency code", "ccy"],
    },
    {
      key: "subtotal",
      label: "Subtotal",
      importance: "optional",
      type: "money",
      scope: "order",
      aliases: ["subtotal", "sub total", "net amount", "items total"],
    },
    {
      key: "discount_total",
      label: "Discount",
      importance: "optional",
      type: "money",
      scope: "order",
      aliases: ["discount", "discount total", "discounts", "total discount"],
    },
    {
      key: "tax_total",
      label: "Tax",
      importance: "optional",
      type: "money",
      scope: "order",
      aliases: ["tax", "tax total", "vat", "gst", "total tax"],
    },
    {
      key: "shipping_total",
      label: "Shipping",
      importance: "optional",
      type: "money",
      scope: "order",
      aliases: ["shipping", "shipping total", "delivery", "freight", "postage"],
    },
    {
      key: "product_name",
      label: "Product name",
      importance: "optional",
      type: "text",
      scope: "line",
      aliases: ["product", "product name", "item", "item name", "title", "description"],
    },
    {
      key: "unit_price",
      label: "Unit price",
      importance: "optional",
      type: "money",
      scope: "line",
      aliases: ["unit price", "price", "item price", "selling price", "price per unit"],
    },
    {
      key: "line_total",
      label: "Line total",
      importance: "optional",
      type: "money",
      scope: "line",
      aliases: ["line total", "item total", "row total", "line amount"],
    },
  ],
}

const PRODUCTS: EntityDef = {
  key: "PRODUCTS",
  label: "Products",
  description: "One row per product. This is where cost prices come from.",
  unlocks: ["Cost of goods", "Gross margin", "Inventory levels"],
  fields: [
    {
      key: "sku",
      label: "SKU",
      importance: "required",
      type: "text",
      help: "The unique product code. Used to match order lines to this product.",
      aliases: ["sku", "product code", "item code", "code", "product sku", "variant sku"],
    },
    {
      key: "name",
      label: "Product name",
      importance: "required",
      type: "text",
      aliases: ["name", "product", "product name", "item", "item name", "title", "description"],
    },
    {
      key: "unit_cost",
      label: "Unit cost",
      importance: "recommended",
      type: "money",
      help: "What one unit costs you.",
      consequence:
        "This is the field that fixes the 'profit is overstated' warning on your dashboard. Without it, margin cannot be calculated.",
      aliases: ["cost", "unit cost", "cost price", "buy price", "purchase price", "cogs", "wholesale price"],
    },
    {
      key: "unit_price",
      label: "Selling price",
      importance: "optional",
      type: "money",
      aliases: ["price", "unit price", "selling price", "retail price", "sale price", "rrp"],
    },
    {
      key: "category",
      label: "Category",
      importance: "optional",
      type: "text",
      aliases: ["category", "product category", "type", "department", "group"],
    },
    {
      key: "brand",
      label: "Brand",
      importance: "optional",
      type: "text",
      aliases: ["brand", "manufacturer", "vendor", "supplier"],
    },
    {
      key: "barcode",
      label: "Barcode",
      importance: "optional",
      type: "text",
      aliases: ["barcode", "ean", "upc", "gtin", "isbn"],
    },
    {
      key: "opening_stock",
      label: "Stock on hand",
      importance: "optional",
      type: "number",
      help: "Current quantity in stock. Recorded as an opening balance.",
      aliases: ["stock", "quantity", "qty", "stock on hand", "inventory", "on hand", "available"],
    },
    {
      key: "reorder_point",
      label: "Reorder point",
      importance: "optional",
      type: "number",
      help: "Stock level at which you want to be warned.",
      aliases: ["reorder point", "reorder level", "min stock", "minimum stock", "low stock threshold"],
    },
  ],
}

const EXPENSES: EntityDef = {
  key: "EXPENSES",
  label: "Expenses",
  description: "One row per business cost. These turn gross profit into net profit.",
  unlocks: ["Net profit", "Net margin", "Expense trends"],
  fields: [
    {
      key: "incurred_at",
      label: "Date",
      importance: "required",
      type: "date",
      aliases: ["date", "expense date", "incurred at", "transaction date", "paid on", "posted date"],
    },
    {
      key: "amount",
      label: "Amount",
      importance: "required",
      type: "money",
      help: "How much was spent. Must not be negative.",
      aliases: ["amount", "total", "cost", "value", "debit", "expense", "spend"],
    },
    {
      key: "category",
      label: "Category",
      importance: "recommended",
      type: "text",
      help: "For example Marketing, Rent, Salaries.",
      consequence:
        "Without categories, expenses cannot be broken down, so 'where is my money going' cannot be answered.",
      aliases: ["category", "type", "expense type", "account", "classification"],
    },
    {
      key: "description",
      label: "Description",
      importance: "optional",
      type: "text",
      aliases: ["description", "details", "memo", "note", "narrative", "particulars"],
    },
    {
      key: "vendor",
      label: "Paid to",
      importance: "optional",
      type: "text",
      aliases: ["vendor", "supplier", "payee", "paid to", "merchant", "company"],
    },
    {
      key: "external_id",
      label: "Reference",
      importance: "optional",
      type: "text",
      help: "An invoice or transaction reference.",
      consequence:
        "Without a reference, re-importing this file would add these expenses a second time.",
      aliases: ["reference", "ref", "invoice number", "invoice", "transaction id", "receipt number", "id"],
    },
    {
      key: "currency",
      label: "Currency",
      importance: "optional",
      type: "text",
      help: "Must match your business currency. Nothing is converted.",
      aliases: ["currency", "currency code", "ccy"],
    },
  ],
}

export const ENTITIES: Record<EntityKey, EntityDef> = { ORDERS, PRODUCTS, EXPENSES }

export const ENTITY_LIST: EntityDef[] = [ORDERS, PRODUCTS, EXPENSES]

export function getEntity(key: EntityKey): EntityDef {
  return ENTITIES[key]
}
