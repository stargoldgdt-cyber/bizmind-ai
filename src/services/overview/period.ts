import { parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"

/**
 * The executive dashboard's period (2026-09-21): a run of whole calendar
 * months ending on a chosen month -- by default the latest month with data,
 * because sellers upload statements after a month closes, so "this calendar
 * month" is usually still empty.
 *
 * Only calendar arithmetic happens here. Every figure for the period, and the
 * comparison with the same number of months before it, comes from SQL
 * (dashboard_overview, migration 0049).
 */

export const PERIOD_KEYS = ["1m", "3m", "ytd", "12m"] as const
export type PeriodKey = (typeof PERIOD_KEYS)[number]

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  "1m": "Month",
  "3m": "3 months",
  ytd: "Year to date",
  "12m": "12 months",
}

export type OverviewPeriod = {
  key: PeriodKey
  /** The last month of the period. */
  end: LedgerMonth
  /** The first month of the period. */
  start: LedgerMonth
  /** First instant, ISO UTC. */
  from: string
  /** First instant after the period, ISO UTC (exclusive). */
  to: string
  months: number
  single: boolean
  /** "June 2026", "Apr – Jun 2026", "Jul 2025 – Jun 2026". */
  label: string
  /** What it is compared with: "May 2026", "the previous 3 months". */
  previousLabel: string
}

export function isPeriodKey(value: string | null | undefined): value is PeriodKey {
  return (PERIOD_KEYS as readonly string[]).includes(value ?? "")
}

const SHORT = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" })
const SHORT_YEAR = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })

/** The month `offset` months from `month` (negative goes back). */
export function shiftMonth(month: LedgerMonth, offset: number): LedgerMonth {
  const start = new Date(month.from)
  const shifted = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1))
  return parseLedgerMonth(shifted.toISOString().slice(0, 7))!
}

export function resolvePeriod(key: PeriodKey, end: LedgerMonth): OverviewPeriod {
  const endStart = new Date(end.from)
  const start =
    key === "1m"
      ? end
      : key === "3m"
        ? shiftMonth(end, -2)
        : key === "12m"
          ? shiftMonth(end, -11)
          : parseLedgerMonth(`${endStart.getUTCFullYear()}-01`)!
  const months =
    (endStart.getUTCFullYear() - new Date(start.from).getUTCFullYear()) * 12 +
    (endStart.getUTCMonth() - new Date(start.from).getUTCMonth()) +
    1
  const single = months === 1
  const sameYear = start.key.slice(0, 4) === end.key.slice(0, 4)
  const label = single
    ? end.label
    : sameYear
      ? `${SHORT.format(new Date(start.from))} – ${SHORT_YEAR.format(new Date(end.from))}`
      : `${SHORT_YEAR.format(new Date(start.from))} – ${SHORT_YEAR.format(new Date(end.from))}`
  return {
    key,
    end,
    start,
    from: start.from,
    to: end.to,
    months,
    single,
    label: key === "ytd" && !single ? `${label} (year to date)` : label,
    previousLabel: single ? shiftMonth(end, -1).label : `the previous ${months} months`,
  }
}
