import { createHash } from "node:crypto"

import { z } from "zod"

import { isExactNumber } from "@/lib/json-exact"
import type {
  EntityKey,
  ImportOptions,
  Mapping,
  NormalizedRow,
  RawRecord,
  RowIssue,
} from "@/services/ingestion/contracts"
import { ENTITIES } from "@/services/ingestion/entities"
import { normalizeText } from "@/services/ingestion/normalize"
import { validate } from "@/services/ingestion/validate"

/**
 * A table-shaped page -- a spreadsheet's rows -- made ready to write.
 *
 * ONE MAPPING ENGINE
 * ------------------
 * Nothing here decides what a column means or whether a value is readable.
 * The owner's confirmed mapping is applied by `validate()`, the function every
 * Excel and CSV upload goes through, with the same date and number rules. This
 * file adds only what a LIVE source needs on top of that:
 *
 *   - IDENTITY. Every record needs a stable key -- the order ID, the SKU, the
 *     expense reference -- because a live sheet is read again and again, and a
 *     row number moves whenever someone sorts or inserts. A row without one is
 *     reported and skipped, never given an invented key.
 *   - ALL OR NOTHING PER RECORD. If any row of an order has a problem, the
 *     order is not written at all, and whatever BizMind already holds for it
 *     stays as it was. Writing only the readable lines would replace the
 *     order's lines with fewer of them -- a quiet change to cost of goods.
 *   - A FINGERPRINT per record, so a sheet read again after one edit writes
 *     only what that edit changed.
 *
 * Pure: no network, no database. The worker does the writing.
 */

/** Part of every fingerprint. Changing how records are shaped means bumping it. */
export const FINGERPRINT_VERSION = "sheets-v1"

const settingsSchema = z.object({
  entity: z.enum(["ORDERS", "PRODUCTS", "EXPENSES"]),
  mapping: z.record(z.string(), z.string()),
  date_format: z.enum(["auto", "DMY", "MDY", "YMD"]),
  decimal_separator: z.enum([".", ","]),
})

/** The field that identifies a record, per entity. */
export const IDENTITY: Record<EntityKey, { field: string; label: string }> = {
  ORDERS: { field: "external_id", label: "Order ID" },
  PRODUCTS: { field: "sku", label: "SKU" },
  EXPENSES: { field: "external_id", label: "Reference" },
}

const NO_IDENTITY: Record<EntityKey, string> = {
  ORDERS:
    "This row has no Order ID, so BizMind cannot tell which order it belongs to. It was skipped.",
  PRODUCTS: "This row has no SKU, so BizMind cannot tell which product it is. It was skipped.",
  EXPENSES:
    "This row has no Reference. A synced expense needs one, or an edit to it would be " +
    "counted as a second expense. It was skipped.",
}

export type SheetSettings = {
  entity: EntityKey
  mapping: Mapping
  options: ImportOptions
}

export type SettingsResult =
  | { ok: true; settings: SheetSettings }
  | { ok: false; reason: string }

/**
 * The owner's choices for one tab, checked against the sheet as it is now.
 *
 * Anything wrong here is a MAPPING REVIEW, not a row problem: the sheet no
 * longer fits what the owner confirmed, and choosing a different column would
 * be deciding what their data means on their behalf.
 */
export function readSheetSettings(
  metadata: Record<string, unknown>,
  headers?: readonly string[]
): SettingsResult {
  const parsed = settingsSchema.safeParse(metadata)
  if (!parsed.success) {
    return {
      ok: false,
      reason: "This sheet's column choices are missing. Review the connection and confirm them.",
    }
  }

  const { entity } = parsed.data
  const definition = ENTITIES[entity]

  // Only BizMind's own fields, and only columns actually chosen.
  const mapping: Mapping = {}
  for (const field of definition.fields) {
    const column = parsed.data.mapping[field.key]
    if (column && column.trim() !== "") mapping[field.key] = column
  }

  const missing = definition.fields.filter((f) => f.importance === "required" && !mapping[f.key])
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `These required columns are not chosen: ${missing.map((f) => f.label).join(", ")}.`,
    }
  }

  const identity = IDENTITY[entity]
  if (!mapping[identity.field]) {
    return {
      ok: false,
      reason:
        `A synced ${definition.label} tab needs a ${identity.label} column. Without one, ` +
        `BizMind cannot tell a new row from an edited one, so an edit would be counted twice.`,
    }
  }

  if (headers) {
    const present = new Set(headers)
    for (const field of definition.fields) {
      const column = mapping[field.key]
      if (column && !present.has(column)) {
        return {
          ok: false,
          reason:
            `The column "${column}", which BizMind reads ${field.label} from, is no longer ` +
            `in the sheet. Review the connection.`,
        }
      }
    }
  }

  return {
    ok: true,
    settings: {
      entity,
      mapping,
      options: {
        dateFormat: parsed.data.date_format,
        decimalSeparator: parsed.data.decimal_separator,
        // Unused by validate(). Where a synced record came from is decided by
        // the connection's channel, in the database.
        source: "OTHER",
        // The owner acknowledged unmapped recommended fields when connecting.
        acknowledgedWarnings: true,
      },
    },
  }
}

/** Recommended fields left unchosen, with what each one costs. */
export function missingRecommended(entity: EntityKey, mapping: Mapping) {
  return ENTITIES[entity].fields
    .filter((f) => f.importance === "recommended" && !mapping[f.key])
    .map((f) => ({
      field: f.key,
      label: f.label,
      consequence: f.consequence ?? "Some figures will be incomplete.",
    }))
}

export type PreparedRecord = {
  key: string
  /** Fingerprint of what would be written -- or of the rows, when rejected. */
  hash: string
  /** Where it was found this time. Lineage only: rows move. */
  locator: { rows: number[] }
  /** The validated record, or null when any of its rows has a problem. */
  row: NormalizedRow | null
}

export type PreparedIssue = { key: string | null; issue: RowIssue }

export type PreparedPage = {
  records: PreparedRecord[]
  /** Every problem found, tied to its record's key where it has one. */
  issues: PreparedIssue[]
  /** Rows skipped because they had no identity at all. */
  unkeyedRows: number
}

export function prepareTabularPage(input: {
  settings: SheetSettings
  businessCurrency: string
  records: readonly RawRecord[]
  /** The sheet row each record came from, so a problem names the real row. */
  rowNumbers: readonly number[]
}): PreparedPage {
  const { settings, businessCurrency } = input
  const definition = ENTITIES[settings.entity]
  const identity = IDENTITY[settings.entity]
  const column = settings.mapping[identity.field]

  const issues: PreparedIssue[] = []
  const groups = new Map<string, { records: RawRecord[]; rows: number[] }>()
  let unkeyedRows = 0

  input.records.forEach((record, index) => {
    const rowNumber = input.rowNumbers[index] ?? 0
    const key = normalizeText(record[column])

    if (key === null) {
      unkeyedRows += 1
      issues.push({
        key: null,
        issue: { rowNumber, severity: "ERROR", field: identity.field, message: NO_IDENTITY[settings.entity] },
      })
      return
    }

    const group = groups.get(key) ?? { records: [], rows: [] }
    group.records.push(record)
    group.rows.push(rowNumber)
    groups.set(key, group)
  })

  const prepared: PreparedRecord[] = []

  for (const [key, group] of groups) {
    // One record's rows, validated on their own. Every check validate() makes
    // across rows -- an order total that disagrees, a SKU listed twice -- is
    // between rows with the SAME key, so validating per key finds exactly what
    // validating the whole page would, and ties each problem to its record.
    const result = validate(definition, group.records, settings.mapping, settings.options, businessCurrency)

    for (const issue of result.issues) {
      // validate() numbers rows from 2, as if they sat under a heading row.
      const rowNumber = group.rows[issue.rowNumber - 2] ?? group.rows[0]
      issues.push({ key, issue: { ...issue, rowNumber } })
    }

    const written = result.rows[result.rows.length - 1]
    const rejected = result.failedRowCount > 0 || written === undefined

    if (rejected && written !== undefined) {
      issues.push({
        key,
        issue: {
          rowNumber: group.rows[0],
          severity: "ERROR",
          field: identity.field,
          message:
            `${identity.label} "${key}" was not imported or updated, because one of its rows ` +
            `has a problem. Whatever BizMind already holds for it is unchanged.`,
        },
      })
    }

    prepared.push({
      key,
      hash: rejected ? fingerprint("rejected", group.records) : fingerprint("record", written),
      locator: { rows: group.rows },
      row: rejected ? null : written,
    })
  }

  return { records: prepared, issues, unkeyedRows }
}

function fingerprint(kind: "record" | "rejected", value: unknown): string {
  return createHash("sha256")
    .update(`${FINGERPRINT_VERSION}|${kind}|${stableJson(value)}`)
    .digest("hex")
}

/** JSON with object keys sorted, so the same content always hashes the same. */
function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "null"
  // Tagged, so a number cell and a text cell with the same digits differ.
  if (isExactNumber(value)) return `{"#":${JSON.stringify(value.text)}}`
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}
