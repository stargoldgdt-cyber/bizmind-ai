/**
 * Value helpers for noon reports. Text in, text out: nothing here parses money
 * into a number or does arithmetic on it (MONEY.md).
 */

export const EXACT_DECIMAL = /^-?[0-9]{1,16}(\.[0-9]{1,4})?$/

/** A trimmed cell, or null when the cell is blank. */
export function cell(raw: Readonly<Record<string, string | null>>, column: string): string | null {
  const value = raw[column]
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

/** "0", "0.00", "-0" -- a reported zero. */
export function isZeroDecimal(value: string): boolean {
  return /^-?0+(\.0+)?$/.test(value)
}

/** Changes the sign of exact decimal text. Not arithmetic. */
export function negateDecimal(value: string): string {
  if (isZeroDecimal(value)) return value.replace(/^-/, "")
  return value.startsWith("-") ? value.slice(1) : `-${value}`
}

/**
 * A noon date ("2026-07-31") as the first instant of that calendar day in UTC.
 *
 * noon's reports carry a date and no time. The date is what noon reports, so it
 * is kept as that calendar day; the P&L engine counts months in UTC, so the day
 * lands in the month noon stated. Nothing else is inferred.
 */
export function parseNoonDate(value: string | null): string | null {
  if (value === null) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [, y, m, d] = match
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(m) - 1 || probe.getUTCDate() !== Number(d)) {
    return null
  }
  return `${y}-${m}-${d}T00:00:00Z`
}
