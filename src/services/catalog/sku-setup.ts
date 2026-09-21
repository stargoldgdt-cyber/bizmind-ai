import { compareMoney } from "@/services/analytics/money"
import { normalizeSku, UNIT_COST_PATTERN } from "@/services/catalog/sku"

/**
 * The one-sheet SKU setup (migration 0045), without a database.
 *
 * The seller downloads ONE sheet listing the marketplace SKUs that need a
 * product, fills in the Product SKU (and optionally a name and the unit cost),
 * and uploads it again. This module defines the sheet's columns and checks a
 * filled sheet row by row BEFORE anything is applied, so the seller sees every
 * problem with its row number and only rows that agree are sent to
 * `sku_setup_apply()`, which checks them all again.
 *
 * Rules (owner decisions, 2026-09-18):
 *   - A cost belongs to the PRODUCT. Several rows with the same Product SKU
 *     and the same cost are one cost; different costs for one Product SKU in
 *     one currency are refused, naming every row involved.
 *   - A marketplace SKU is one product: two Product SKUs for it are refused.
 *   - A row with neither a Product SKU nor a cost is left for later, silently.
 *
 * Nothing is calculated: costs are compared with `compareMoney`, never
 * converted to numbers.
 */

export const SKU_SETUP_COLUMNS = [
  { key: "marketplace", header: "Marketplace", filledBy: "BIZMIND" },
  { key: "account", header: "Marketplace Account", filledBy: "BIZMIND" },
  { key: "rawSku", header: "Marketplace SKU", filledBy: "BIZMIND" },
  { key: "productSku", header: "Product SKU", filledBy: "SELLER" },
  { key: "productName", header: "Product Name", filledBy: "SELLER" },
  { key: "unitCost", header: "COGS / Unit", filledBy: "SELLER" },
  { key: "currency", header: "Currency", filledBy: "BIZMIND" },
  { key: "unitsSold", header: "Units Sold", filledBy: "BIZMIND" },
  { key: "netSales", header: "Net Sales", filledBy: "BIZMIND" },
] as const

export type SkuSetupColumnKey = (typeof SKU_SETUP_COLUMNS)[number]["key"]

export const MARKETPLACE_NAMES: Record<string, string> = {
  AMAZON: "Amazon",
  NOON: "noon",
  CARREFOUR: "Carrefour",
}

/** "Amazon", "amazon" or "AMAZON" -> "AMAZON"; unknown -> null. */
export function marketplaceCodeOf(value: string): string | null {
  const wanted = value.trim().toUpperCase()
  if (wanted === "") return null
  for (const [code, name] of Object.entries(MARKETPLACE_NAMES)) {
    if (wanted === code || wanted === name.toUpperCase()) return code
  }
  return null
}

/** One row as read from the sheet: every cell as trimmed text. */
export type SkuSetupRecord = {
  rowNumber: number
  cells: Partial<Record<SkuSetupColumnKey, string>>
}

/** A row that passed every check, in the shape `sku_setup_apply()` takes. */
export type SkuSetupRow = {
  row: number
  marketplace_code: string
  raw_sku: string
  product_sku: string
  product_name: string | null
  unit_cost: string | null
  currency: string | null
}

export type SkuSetupIssue = { rowNumber: number; message: string }

export type SkuSetupCheck = {
  rows: SkuSetupRow[]
  issues: SkuSetupIssue[]
  /** Rows with neither a Product SKU nor a cost: left for later. */
  leftBlank: number
  /** Distinct products the valid rows point at. */
  products: number
}

const MAX_PRODUCT_SKU = 120
const MAX_PRODUCT_NAME = 200

/**
 * Checks a filled setup sheet.
 *
 * `knownSkus` holds `${marketplaceCode}|${rawSku}` for every SKU in the
 * business's marketplace files, so a mistyped SKU is reported on its row.
 */
export function checkSkuSetup(records: SkuSetupRecord[], knownSkus: ReadonlySet<string>): SkuSetupCheck {
  const issues: SkuSetupIssue[] = []
  const candidates: SkuSetupRow[] = []
  let leftBlank = 0

  for (const { rowNumber, cells } of records) {
    const text = (key: SkuSetupColumnKey) => (cells[key] ?? "").trim()
    const productSku = text("productSku")
    const unitCost = text("unitCost").replace(/\s+/g, "")
    const fail = (message: string) => issues.push({ rowNumber, message })

    if (productSku === "" && unitCost === "") {
      leftBlank += 1
      continue
    }
    if (productSku === "") {
      fail("Add the Product SKU this cost belongs to.")
      continue
    }
    if (productSku.length > MAX_PRODUCT_SKU) {
      fail(`A Product SKU has at most ${MAX_PRODUCT_SKU} characters.`)
      continue
    }
    if (normalizeSku(productSku) === "") {
      fail("The Product SKU needs letters or digits.")
      continue
    }
    const productName = text("productName")
    if (productName.length > MAX_PRODUCT_NAME) {
      fail(`A Product Name has at most ${MAX_PRODUCT_NAME} characters.`)
      continue
    }

    const marketplaceCode = marketplaceCodeOf(text("marketplace"))
    if (!marketplaceCode) {
      fail(`"${text("marketplace") || "(empty)"}" is not a marketplace BizMind knows. Keep the value from the download.`)
      continue
    }
    const rawSku = text("rawSku")
    if (rawSku === "") {
      fail("The Marketplace SKU is empty. Keep the value from the download.")
      continue
    }
    if (!knownSkus.has(`${marketplaceCode}|${rawSku}`)) {
      fail(`SKU "${rawSku}" is not in your ${MARKETPLACE_NAMES[marketplaceCode]} files. Keep the value from the download.`)
      continue
    }

    let currency: string | null = null
    if (unitCost !== "") {
      if (!UNIT_COST_PATTERN.test(unitCost)) {
        fail("Enter the COGS / Unit as a plain number with at most 4 decimals, for example 120 or 42.50.")
        continue
      }
      currency = text("currency").toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) {
        fail("A cost needs its currency, for example AED.")
        continue
      }
    }

    candidates.push({
      row: rowNumber,
      marketplace_code: marketplaceCode,
      raw_sku: rawSku,
      product_sku: productSku,
      product_name: productName === "" ? null : productName,
      unit_cost: unitCost === "" ? null : unitCost,
      currency,
    })
  }

  // One Product SKU, one cost per currency.
  const refused = new Set<number>()
  const byProductCurrency = new Map<string, SkuSetupRow[]>()
  for (const row of candidates) {
    if (row.unit_cost === null) continue
    const key = `${normalizeSku(row.product_sku)}|${row.currency}`
    byProductCurrency.set(key, [...(byProductCurrency.get(key) ?? []), row])
  }
  for (const group of byProductCurrency.values()) {
    const distinct = group.filter(
      (row, index) => group.findIndex((other) => compareMoney(other.unit_cost, row.unit_cost) === 0) === index
    )
    if (distinct.length < 2) continue
    const rowList = group.map((r) => r.row).join(", ")
    const costs = distinct.map((r) => `${r.currency} ${r.unit_cost}`).join(", ")
    for (const row of group) {
      refused.add(row.row)
      issues.push({
        rowNumber: row.row,
        message: `Product SKU "${row.product_sku}" has different costs on rows ${rowList} (${costs}). Keep one cost per product.`,
      })
    }
  }

  // One marketplace SKU, one product.
  const bySku = new Map<string, SkuSetupRow[]>()
  for (const row of candidates) {
    const key = `${row.marketplace_code}|${row.raw_sku}`
    bySku.set(key, [...(bySku.get(key) ?? []), row])
  }
  for (const group of bySku.values()) {
    const products = new Set(group.map((r) => normalizeSku(r.product_sku)))
    if (products.size < 2) continue
    const rowList = group.map((r) => r.row).join(", ")
    for (const row of group) {
      if (refused.has(row.row)) continue
      refused.add(row.row)
      issues.push({
        rowNumber: row.row,
        message: `Marketplace SKU "${row.raw_sku}" is given different Product SKUs on rows ${rowList}. A SKU is one product.`,
      })
    }
  }

  const rows = candidates.filter((row) => !refused.has(row.row))
  issues.sort((a, b) => a.rowNumber - b.rowNumber)
  return {
    rows,
    issues,
    leftBlank,
    products: new Set(rows.map((r) => normalizeSku(r.product_sku))).size,
  }
}
