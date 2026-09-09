import type {
  EntityDef,
  ImportOptions,
  Mapping,
  NormalizedExpense,
  NormalizedOrder,
  NormalizedOrderItem,
  NormalizedProduct,
  RawRecord,
  RowIssue,
  ValidationResult,
} from "./contracts"
import {
  normalizeCurrency,
  normalizeDate,
  normalizeDecimal,
  normalizeStatus,
  normalizeText,
} from "./normalize"

/**
 * Validation and normalisation.
 *
 * Writes nothing. Produces exactly what WOULD be written plus every problem
 * found, so the user sees the outcome before committing to it.
 *
 * Two principles run through this file:
 *
 *  1. A row that cannot be read is REPORTED, not repaired. Rows with errors
 *     are skipped; the rest still import.
 *  2. A missing recommended field does not block the import, but it is
 *     surfaced with its consequence and must be acknowledged. The user is
 *     never allowed to believe a figure is complete when it is not.
 */

const MAX_ISSUES = 500

type Ctx = {
  entity: EntityDef
  mapping: Mapping
  options: ImportOptions
  businessCurrency: string
  issues: RowIssue[]
}

function addIssue(ctx: Ctx, issue: RowIssue) {
  if (ctx.issues.length < MAX_ISSUES) ctx.issues.push(issue)
}

/** Raw cell for a canonical field, or undefined when the field is unmapped. */
function cell(row: RawRecord, mapping: Mapping, key: string): unknown {
  const column = mapping[key]
  if (!column) return undefined
  return row[column]
}

/** Recommended fields the user chose not to map, with what each one costs. */
function findMissingRecommended(entity: EntityDef, mapping: Mapping) {
  return entity.fields
    .filter((f) => f.importance === "recommended" && !mapping[f.key])
    .map((f) => ({
      field: f.key,
      label: f.label,
      consequence: f.consequence ?? "Some figures will be incomplete.",
    }))
}

export function validate(
  entity: EntityDef,
  rows: RawRecord[],
  mapping: Mapping,
  options: ImportOptions,
  businessCurrency: string
): ValidationResult {
  const ctx: Ctx = { entity, mapping, options, businessCurrency, issues: [] }

  // A missing REQUIRED field is not a per-row problem — the whole file cannot
  // be read, so say that once rather than repeating it thousands of times.
  const missingRequired = entity.fields.filter(
    (f) => f.importance === "required" && !mapping[f.key]
  )

  if (missingRequired.length > 0) {
    return {
      rows: [],
      issues: [],
      failedRowCount: rows.length,
      validRowCount: 0,
      missingRecommended: findMissingRecommended(entity, mapping),
      blocked: true,
      blockedReason:
        `These required columns are not mapped: ` +
        missingRequired.map((f) => f.label).join(", ") +
        `. Map them to continue — BizMind will not guess which column holds them.`,
    }
  }

  const result =
    entity.key === "ORDERS"
      ? validateOrders(ctx, rows)
      : entity.key === "PRODUCTS"
        ? validateProducts(ctx, rows)
        : validateExpenses(ctx, rows)

  return {
    ...result,
    issues: ctx.issues,
    missingRecommended: findMissingRecommended(entity, mapping),
    blocked: result.validRowCount === 0,
    blockedReason:
      result.validRowCount === 0
        ? "No rows could be read. Fix the problems listed below and upload again."
        : undefined,
  }
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

/** Order-level fields, used to detect rows that disagree about the same order. */
const ORDER_LEVEL_MONEY = [
  "subtotal",
  "discount_total",
  "tax_total",
  "shipping_total",
  "fee_total",
  "total",
] as const

function validateOrders(ctx: Ctx, rows: RawRecord[]) {
  const orders = new Map<string, NormalizedOrder>()
  const firstRowOf = new Map<string, number>()
  const failedRows = new Set<number>()

  rows.forEach((row, index) => {
    const rowNumber = index + 2 // 1-based, and row 1 is the header.
    let rowFailed = false

    const failRow = (field: string | undefined, message: string, raw?: unknown) => {
      rowFailed = true
      addIssue(ctx, {
        rowNumber,
        severity: "ERROR",
        field,
        message,
        rawValue: raw === undefined ? undefined : String(raw).slice(0, 120),
      })
    }

    const externalId = normalizeText(cell(row, ctx.mapping, "external_id"))
    if (!externalId) failRow("external_id", "Order ID is empty.")

    const placedRaw = cell(row, ctx.mapping, "placed_at")
    const placed = normalizeDate(placedRaw, ctx.options.dateFormat)
    if (!placed.ok) failRow("placed_at", `Order date: ${placed.reason}`, placedRaw)

    const totalRaw = cell(row, ctx.mapping, "total")
    const total = normalizeDecimal(totalRaw, ctx.options.decimalSeparator, {
      allowNegative: true,
    })
    if (!total.ok) failRow("total", `Order total: ${total.reason}`, totalRaw)

    const currencyRaw = cell(row, ctx.mapping, "currency")
    const currency = normalizeCurrency(currencyRaw, ctx.businessCurrency)
    if (!currency.ok) failRow("currency", currency.reason, currencyRaw)

    const statusRaw = cell(row, ctx.mapping, "status")
    const status = normalizeStatus(statusRaw)
    if (!status.ok) failRow("status", status.reason, statusRaw)

    // Optional order-level money. Present but unreadable is an error, because
    // treating it as zero would understate fees and overstate profit.
    const money: Record<string, string> = {}
    for (const key of ORDER_LEVEL_MONEY) {
      if (key === "total") continue
      const raw = cell(row, ctx.mapping, key)
      if (raw === undefined || normalizeText(raw) === null) continue
      const parsed = normalizeDecimal(raw, ctx.options.decimalSeparator, {
        allowNegative: true,
      })
      if (!parsed.ok) {
        failRow(key, `${key.replace(/_/g, " ")}: ${parsed.reason}`, raw)
      } else {
        money[key] = parsed.value
      }
    }

    // Line item. Quantity is only required once a line is actually described.
    const sku = normalizeText(cell(row, ctx.mapping, "sku"))
    const productName = normalizeText(cell(row, ctx.mapping, "product_name"))
    const qtyRaw = cell(row, ctx.mapping, "quantity")
    const hasLine = sku !== null || productName !== null || normalizeText(qtyRaw) !== null

    let item: NormalizedOrderItem | null = null

    if (hasLine) {
      const qty = normalizeDecimal(qtyRaw ?? 1, ctx.options.decimalSeparator, {
        allowNegative: true,
      })
      if (!qty.ok) {
        failRow("quantity", `Quantity: ${qty.reason}`, qtyRaw)
      } else if (Number(qty.value) === 0) {
        failRow("quantity", "Quantity is zero, so this line cannot be counted.", qtyRaw)
      } else {
        const lineMoney: Record<string, string | null> = {}
        for (const key of ["unit_price", "unit_cost", "line_total"] as const) {
          const raw = cell(row, ctx.mapping, key)
          if (raw === undefined || normalizeText(raw) === null) {
            lineMoney[key] = null
            continue
          }
          const parsed = normalizeDecimal(raw, ctx.options.decimalSeparator, {
            allowNegative: key !== "unit_cost",
          })
          if (!parsed.ok) {
            failRow(key, `${key.replace(/_/g, " ")}: ${parsed.reason}`, raw)
          } else {
            lineMoney[key] = parsed.value
          }
        }

        // Absent values stay null. Substituting 0 would turn "we do not know
        // what this line sold for" into "it sold for nothing".
        item = {
          sku,
          name: productName,
          quantity: qty.value,
          unit_price: lineMoney.unit_price,
          unit_cost: lineMoney.unit_cost,
          line_total: lineMoney.line_total,
          discount: null,
          tax: null,
        }
      }
    }

    if (rowFailed || !externalId || !placed.ok || !total.ok || !currency.ok || !status.ok) {
      failedRows.add(rowNumber)
      return
    }

    const existing = orders.get(externalId)

    if (!existing) {
      firstRowOf.set(externalId, rowNumber)
      orders.set(externalId, {
        external_id: externalId,
        order_number: normalizeText(cell(row, ctx.mapping, "order_number")),
        placed_at: placed.value,
        status: status.value,
        currency: currency.value,
        // `?? null`, never `?? "0"`. A column the file did not contain is
        // unknown, and the database now stores that distinction.
        subtotal: money.subtotal ?? null,
        discount_total: money.discount_total ?? null,
        tax_total: money.tax_total ?? null,
        shipping_total: money.shipping_total ?? null,
        fee_total: money.fee_total ?? null,
        total: total.value,
        customer_email: normalizeText(cell(row, ctx.mapping, "customer_email")),
        customer_name: normalizeText(cell(row, ctx.mapping, "customer_name")),
        items: item ? [item] : [],
      })
      return
    }

    // Same order across several rows — normal for line-per-row exports. But if
    // the rows DISAGREE about the order total, one of them is wrong and we
    // must not pick a winner: that would silently change revenue.
    if (existing.total !== total.value) {
      addIssue(ctx, {
        rowNumber,
        severity: "ERROR",
        field: "total",
        message:
          `Order "${externalId}" appears on row ${firstRowOf.get(externalId)} with a ` +
          `total of ${existing.total}, but ${total.value} here. BizMind will not ` +
          `choose between them — correct the file so every row for an order agrees.`,
        rawValue: String(totalRaw ?? "").slice(0, 120),
      })
      failedRows.add(rowNumber)
      return
    }

    if (
      money.fee_total !== undefined &&
      existing.fee_total !== null &&
      existing.fee_total !== money.fee_total
    ) {
      addIssue(ctx, {
        rowNumber,
        severity: "ERROR",
        field: "fee_total",
        message:
          `Order "${externalId}" has conflicting channel fees ` +
          `(${existing.fee_total} on row ${firstRowOf.get(externalId)}, ${money.fee_total} here).`,
      })
      failedRows.add(rowNumber)
      return
    }

    if (item) existing.items.push(item)
  })

  // An order with no readable lines still counts as revenue, but its cost is
  // unknown. Flag it rather than let a 100% margin appear unexplained.
  for (const order of orders.values()) {
    if (order.items.length === 0) {
      addIssue(ctx, {
        rowNumber: firstRowOf.get(order.external_id) ?? 0,
        severity: "WARNING",
        field: "quantity",
        message:
          `Order "${order.external_id}" has no product lines, so its cost of goods ` +
          `is unknown and its margin will look better than it is.`,
      })
    }
  }

  return {
    rows: [...orders.values()],
    failedRowCount: failedRows.size,
    validRowCount: orders.size,
  }
}

/* -------------------------------------------------------------------------- */
/* Products                                                                   */
/* -------------------------------------------------------------------------- */

function validateProducts(ctx: Ctx, rows: RawRecord[]) {
  const bySku = new Map<string, NormalizedProduct>()
  const firstRowOf = new Map<string, number>()
  const failedRows = new Set<number>()

  rows.forEach((row, index) => {
    const rowNumber = index + 2
    let failed = false

    const failRow = (field: string, message: string, raw?: unknown) => {
      failed = true
      addIssue(ctx, {
        rowNumber,
        severity: "ERROR",
        field,
        message,
        rawValue: raw === undefined ? undefined : String(raw).slice(0, 120),
      })
    }

    const sku = normalizeText(cell(row, ctx.mapping, "sku"))
    if (!sku) failRow("sku", "SKU is empty.")

    const name = normalizeText(cell(row, ctx.mapping, "name"))
    if (!name) failRow("name", "Product name is empty.")

    const numbers: Record<string, string | null> = {}
    for (const key of ["unit_cost", "unit_price", "opening_stock", "reorder_point"] as const) {
      const raw = cell(row, ctx.mapping, key)
      if (raw === undefined || normalizeText(raw) === null) {
        numbers[key] = null
        continue
      }
      const parsed = normalizeDecimal(raw, ctx.options.decimalSeparator, {
        allowNegative: key === "opening_stock",
      })
      if (!parsed.ok) failRow(key, `${key.replace(/_/g, " ")}: ${parsed.reason}`, raw)
      else numbers[key] = parsed.value
    }

    if (failed || !sku || !name) {
      failedRows.add(rowNumber)
      return
    }

    if (bySku.has(sku)) {
      addIssue(ctx, {
        rowNumber,
        severity: "WARNING",
        field: "sku",
        message:
          `SKU "${sku}" also appears on row ${firstRowOf.get(sku)}. The later row wins.`,
      })
    } else {
      firstRowOf.set(sku, rowNumber)
    }

    bySku.set(sku, {
      sku,
      name,
      description: normalizeText(cell(row, ctx.mapping, "description")),
      category: normalizeText(cell(row, ctx.mapping, "category")),
      brand: normalizeText(cell(row, ctx.mapping, "brand")),
      barcode: normalizeText(cell(row, ctx.mapping, "barcode")),
      unit_cost: numbers.unit_cost,
      unit_price: numbers.unit_price,
      opening_stock: numbers.opening_stock,
      reorder_point: numbers.reorder_point,
    })
  })

  return {
    rows: [...bySku.values()],
    failedRowCount: failedRows.size,
    validRowCount: bySku.size,
  }
}

/* -------------------------------------------------------------------------- */
/* Expenses                                                                   */
/* -------------------------------------------------------------------------- */

function validateExpenses(ctx: Ctx, rows: RawRecord[]) {
  const out: NormalizedExpense[] = []
  const failedRows = new Set<number>()
  const seenReferences = new Map<string, number>()

  rows.forEach((row, index) => {
    const rowNumber = index + 2
    let failed = false

    const failRow = (field: string, message: string, raw?: unknown) => {
      failed = true
      addIssue(ctx, {
        rowNumber,
        severity: "ERROR",
        field,
        message,
        rawValue: raw === undefined ? undefined : String(raw).slice(0, 120),
      })
    }

    const dateRaw = cell(row, ctx.mapping, "incurred_at")
    const date = normalizeDate(dateRaw, ctx.options.dateFormat)
    if (!date.ok) failRow("incurred_at", `Date: ${date.reason}`, dateRaw)

    const amountRaw = cell(row, ctx.mapping, "amount")
    const amount = normalizeDecimal(amountRaw, ctx.options.decimalSeparator)
    if (!amount.ok) failRow("amount", `Amount: ${amount.reason}`, amountRaw)

    const currencyRaw = cell(row, ctx.mapping, "currency")
    const currency = normalizeCurrency(currencyRaw, ctx.businessCurrency)
    if (!currency.ok) failRow("currency", currency.reason, currencyRaw)

    if (failed || !date.ok || !amount.ok || !currency.ok) {
      failedRows.add(rowNumber)
      return
    }

    const reference = normalizeText(cell(row, ctx.mapping, "external_id"))

    if (reference) {
      const seenAt = seenReferences.get(reference)
      if (seenAt) {
        addIssue(ctx, {
          rowNumber,
          severity: "WARNING",
          field: "external_id",
          message: `Reference "${reference}" also appears on row ${seenAt}. Only one will be kept.`,
        })
      }
      seenReferences.set(reference, rowNumber)
    }

    out.push({
      incurred_at: date.value,
      amount: amount.value,
      currency: currency.value,
      category: normalizeText(cell(row, ctx.mapping, "category")),
      description: normalizeText(cell(row, ctx.mapping, "description")),
      vendor: normalizeText(cell(row, ctx.mapping, "vendor")),
      external_id: reference,
    })
  })

  return { rows: out, failedRowCount: failedRows.size, validRowCount: out.length }
}
