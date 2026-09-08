import type { ImportOptions } from "./contracts"

/**
 * Value normalisation.
 *
 * The governing rule: **never resolve an ambiguity by guessing.** A date that
 * could be 3 April or 4 March, or a number that could be 1,234 or 1.234, is
 * rejected with an explanation rather than silently interpreted. A wrong
 * financial figure that looks plausible is the worst outcome this product can
 * produce, and it is exactly what guessing creates.
 *
 * Numbers stay as STRINGS throughout. Converting to a JavaScript number would
 * introduce binary floating point, where 0.10 cannot be represented exactly —
 * the same reason every money column is `numeric` in PostgreSQL.
 */

export type ParseOk<T> = { ok: true; value: T }
export type ParseFail = { ok: false; reason: string }
export type ParseResult<T> = ParseOk<T> | ParseFail

const ok = <T,>(value: T): ParseOk<T> => ({ ok: true, value })
const fail = (reason: string): ParseFail => ({ ok: false, reason })

/* -------------------------------------------------------------------------- */
/* Numbers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Turns a spreadsheet cell into an exact decimal string.
 *
 * Handles currency symbols, thousands separators, spaces, and accounting
 * negatives written as "(123.45)". Deliberately does NOT use parseFloat —
 * the value is validated and rewritten textually so no precision is lost.
 */
export function normalizeDecimal(
  raw: unknown,
  decimalSeparator: "." | ",",
  options: { allowNegative?: boolean } = {}
): ParseResult<string> {
  if (raw === null || raw === undefined) return fail("no value")

  // A spreadsheet cell may already be a real number.
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return fail("not a finite number")
    if (!options.allowNegative && raw < 0) return fail("must not be negative")
    return ok(String(raw))
  }

  let text = String(raw).trim()
  if (text === "") return fail("no value")

  // Accounting notation: (1,234.56) means negative.
  let negative = false
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1).trim()
  }

  // Strip anything that is not a digit, separator or sign: currency symbols,
  // ISO codes, non-breaking spaces.
  text = text.replace(/[^\d.,\-+\s]/g, "").replace(/\s/g, "")

  if (text.startsWith("-")) {
    negative = true
    text = text.slice(1)
  } else if (text.startsWith("+")) {
    text = text.slice(1)
  }

  if (text === "") return fail("no digits found")

  const thousandsSeparator = decimalSeparator === "." ? "," : "."

  // Both separators present: the rightmost is the decimal point. If that
  // contradicts the chosen setting, say so rather than reinterpret it.
  const hasDecimal = text.includes(decimalSeparator)
  const hasThousands = text.includes(thousandsSeparator)

  if (hasDecimal && hasThousands) {
    if (text.lastIndexOf(thousandsSeparator) > text.lastIndexOf(decimalSeparator)) {
      return fail(
        `"${String(raw)}" does not match the chosen number format ` +
          `(decimal separator "${decimalSeparator}")`
      )
    }
  }

  text = text.split(thousandsSeparator).join("")

  if (decimalSeparator === ",") {
    text = text.replace(",", ".")
  }

  // More than one decimal point left means the separators were misread.
  if ((text.match(/\./g) ?? []).length > 1) {
    return fail(`"${String(raw)}" is not a valid number for the chosen format`)
  }

  if (!/^\d*\.?\d*$/.test(text) || text === "." || text === "") {
    return fail(`"${String(raw)}" is not a number`)
  }

  if (text.startsWith(".")) text = `0${text}`
  if (text.endsWith(".")) text = text.slice(0, -1)

  const value = negative ? `-${text}` : text

  if (!options.allowNegative && negative && Number(text) !== 0) {
    return fail("must not be negative")
  }

  return ok(value)
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/

/**
 * Turns a cell into an ISO timestamp.
 *
 * When the format is "auto" and a value could legitimately be read two ways
 * (05/06/2026 — 5 June or 6 May?), this FAILS and tells the user to choose a
 * format. Picking one silently would shift transactions between months and
 * quietly corrupt every period comparison on the dashboard.
 */
export function normalizeDate(
  raw: unknown,
  format: ImportOptions["dateFormat"]
): ParseResult<string> {
  if (raw === null || raw === undefined) return fail("no value")

  // Excel cells arrive from the parser as real Date objects — unambiguous.
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return fail("not a valid date")
    return ok(raw.toISOString())
  }

  // A bare number in a spreadsheet is an Excel serial date.
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return ok(excelSerialToIso(raw))
  }

  const text = String(raw).trim()
  if (text === "") return fail("no value")

  // ISO is unambiguous whatever the chosen format.
  const isoMatch = text.match(ISO_DATE)
  if (isoMatch) {
    const parsed = new Date(text.includes("T") || text.includes(" ") ? text : `${text}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) return fail(`"${text}" is not a valid date`)
    return ok(parsed.toISOString())
  }

  const parts = text.split(/[/.\-\s]+/).filter(Boolean)
  if (parts.length < 3) return fail(`"${text}" is not a date we can read`)

  const [a, b, c] = parts
  if (![a, b, c].every((p) => /^\d+$/.test(p))) {
    return fail(`"${text}" is not a date we can read`)
  }

  let day: number
  let month: number
  let year: number

  if (a.length === 4) {
    // Year first is unambiguous.
    year = Number(a)
    month = Number(b)
    day = Number(c)
  } else if (format === "DMY") {
    day = Number(a)
    month = Number(b)
    year = Number(c)
  } else if (format === "MDY") {
    month = Number(a)
    day = Number(b)
    year = Number(c)
  } else if (format === "YMD") {
    year = Number(a)
    month = Number(b)
    day = Number(c)
  } else {
    // Auto. Only safe when one of the first two parts cannot be a month.
    const first = Number(a)
    const second = Number(b)

    if (first > 12 && second <= 12) {
      day = first
      month = second
      year = Number(c)
    } else if (second > 12 && first <= 12) {
      month = first
      day = second
      year = Number(c)
    } else {
      return fail(
        `"${text}" is ambiguous — it could be day/month or month/day. ` +
          `Choose a date format so this is not guessed.`
      )
    }
  }

  if (year < 100) year += year < 70 ? 2000 : 1900

  if (month < 1 || month > 12) return fail(`"${text}" has an invalid month (${month})`)
  if (day < 1 || day > 31) return fail(`"${text}" has an invalid day (${day})`)

  const date = new Date(Date.UTC(year, month - 1, day))

  // Catches 31 February rolling forward into March.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return fail(`"${text}" is not a real calendar date`)
  }

  return ok(date.toISOString())
}

/**
 * Excel stores dates as days since 1899-12-30, with a deliberate bug that
 * treats 1900 as a leap year. The 1899-12-30 epoch is the standard way to
 * absorb that off-by-one.
 */
function excelSerialToIso(serial: number): string {
  const epoch = Date.UTC(1899, 11, 30)
  const ms = Math.round(serial * 24 * 60 * 60 * 1000)
  return new Date(epoch + ms).toISOString()
}

/* -------------------------------------------------------------------------- */
/* Text, currency, status                                                     */
/* -------------------------------------------------------------------------- */

export function normalizeText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  return text === "" ? null : text
}

/**
 * Currency is checked, never converted.
 *
 * Converting would require an exchange rate, and inventing one would be
 * inventing a financial figure. A file in another currency is refused with an
 * explanation instead.
 */
export function normalizeCurrency(
  raw: unknown,
  businessCurrency: string
): ParseResult<string> {
  const text = normalizeText(raw)
  if (text === null) return ok(businessCurrency)

  const code = text.toUpperCase().replace(/[^A-Z]/g, "")
  if (code.length !== 3) return fail(`"${text}" is not a three-letter currency code`)

  if (code !== businessCurrency.toUpperCase()) {
    return fail(
      `This row is in ${code} but your business reports in ${businessCurrency}. ` +
        `BizMind does not convert currencies, because that would require an ` +
        `exchange rate it cannot verify. Import ${code} sales into a separate business.`
    )
  }

  return ok(code)
}

const STATUS_SYNONYMS: Record<string, string> = {
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  void: "CANCELLED",
  voided: "CANCELLED",
  refunded: "REFUNDED",
  "partially refunded": "PARTIALLY_REFUNDED",
  "partially_refunded": "PARTIALLY_REFUNDED",
  fulfilled: "FULFILLED",
  shipped: "FULFILLED",
  delivered: "FULFILLED",
  complete: "FULFILLED",
  completed: "FULFILLED",
  confirmed: "CONFIRMED",
  paid: "CONFIRMED",
  processing: "CONFIRMED",
  pending: "PENDING",
  unfulfilled: "PENDING",
  open: "PENDING",
}

/**
 * Maps common status wording onto our enum.
 *
 * An unrecognised status is an ERROR, not a default. Quietly treating an
 * unknown status as fulfilled could count a cancelled order as revenue.
 */
export function normalizeStatus(raw: unknown): ParseResult<string> {
  const text = normalizeText(raw)
  if (text === null) return ok("FULFILLED")

  const key = text.toLowerCase().replace(/\s+/g, " ").trim()
  const direct = key.toUpperCase().replace(/\s+/g, "_")

  const known = [
    "PENDING",
    "CONFIRMED",
    "FULFILLED",
    "CANCELLED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
  ]
  if (known.includes(direct)) return ok(direct)

  const mapped = STATUS_SYNONYMS[key]
  if (mapped) return ok(mapped)

  return fail(
    `"${text}" is not a status BizMind recognises. Cancelled orders must be ` +
      `identifiable, so this is not assumed.`
  )
}
