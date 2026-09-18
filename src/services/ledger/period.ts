/**
 * The dashboard's period: one calendar month, in UTC.
 *
 * The P&L engine counts a line in the half-open range [from, to) of its posted
 * time, in UTC (DECISIONS.md, 2026-09-16), so a month here is exactly that
 * range. Nothing in this file touches money.
 */

export type LedgerMonth = {
  /** "2026-07" -- what the URL carries. */
  key: string
  /** First instant of the month, ISO, UTC. */
  from: string
  /** First instant of the next month, ISO, UTC (exclusive). */
  to: string
  /** "July 2026". */
  label: string
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/

const LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })

/** A month from its "YYYY-MM" key, or null when the key is not a real month. */
export function parseLedgerMonth(value: string | null | undefined): LedgerMonth | null {
  const match = value ? MONTH_KEY.exec(value) : null
  if (!match) return null

  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  if (year < 2000 || year > 2100) return null

  const start = new Date(Date.UTC(year, monthIndex, 1))
  // Date.UTC rolls month 12 into January of the next year.
  const next = new Date(Date.UTC(year, monthIndex + 1, 1))

  return {
    key: `${match[1]}-${match[2]}`,
    from: start.toISOString(),
    to: next.toISOString(),
    label: LABEL.format(start),
  }
}

/** "2026-07-01" (a month as the database returns it) -> "2026-07". */
export function monthKeyOf(date: string): string {
  return date.slice(0, 7)
}

/**
 * The calendar month before, as the dashboard compares against it
 * (dashboard_overview uses the same calendar month in SQL).
 */
export function previousLedgerMonth(month: LedgerMonth): LedgerMonth {
  const start = new Date(month.from)
  const before = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1))
  return parseLedgerMonth(before.toISOString().slice(0, 7))!
}
