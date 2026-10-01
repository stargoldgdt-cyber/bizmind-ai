import { parseLedgerMonth, previousLedgerMonth, type LedgerMonth } from "./period"

/**
 * The Marketplace P&L's period picker (owner request, 2026-09-26): This
 * Month, Last Month, This Quarter, This Year, or a single Custom month.
 *
 * Only calendar arithmetic happens here -- no money, so nothing here is
 * subject to the money-guard. Every figure for the resulting range still
 * comes from `pnl_summary(p_from, p_to, ...)` in SQL, unchanged; this module
 * only decides what p_from/p_to are.
 *
 * "This Month" anchors on whatever month the page's own Month dropdown has
 * selected -- never a second, independent idea of "the latest month" -- so
 * the period picker and the dropdown can never disagree about which month is
 * on screen. That dropdown itself still defaults to the latest month with
 * data (services/ledger/period.ts), because a seller uploads a settlement
 * after the month closes, so the page's DEFAULT view is unchanged: the
 * account's or currency's latest month, with no existing link into /ledger
 * behaving differently.
 */

export const PNL_PERIOD_KEYS = ["this_month", "last_month", "this_quarter", "this_year", "custom"] as const
export type PnlPeriodKey = (typeof PNL_PERIOD_KEYS)[number]

export const PNL_PERIOD_LABEL: Record<PnlPeriodKey, string> = {
  this_month: "This Month",
  last_month: "Last Month",
  this_quarter: "This Quarter",
  this_year: "This Year",
  custom: "Custom Range",
}

export function isPnlPeriodKey(value: string | null | undefined): value is PnlPeriodKey {
  return (PNL_PERIOD_KEYS as readonly string[]).includes(value ?? "")
}

/** What every tab of the P&L page reads: a range and the words for it. */
export type PnlPeriod = {
  key: PnlPeriodKey
  from: string
  to: string
  label: string
}

const MONTH_SHORT = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" })
const MONTH_SHORT_YEAR = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })

function quarterOf(anchor: LedgerMonth): PnlPeriod {
  const start = new Date(anchor.from)
  const year = start.getUTCFullYear()
  const quarterStart = Math.floor(start.getUTCMonth() / 3) * 3
  const from = new Date(Date.UTC(year, quarterStart, 1))
  const to = new Date(Date.UTC(year, quarterStart + 3, 1))
  const lastMonthOfQuarter = new Date(Date.UTC(year, quarterStart + 2, 1))
  return {
    key: "this_quarter",
    from: from.toISOString(),
    to: to.toISOString(),
    label: `${MONTH_SHORT.format(from)} – ${MONTH_SHORT_YEAR.format(lastMonthOfQuarter)}`,
  }
}

function yearOf(anchor: LedgerMonth): PnlPeriod {
  const year = new Date(anchor.from).getUTCFullYear()
  return {
    key: "this_year",
    from: new Date(Date.UTC(year, 0, 1)).toISOString(),
    to: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
    label: String(year),
  }
}

/**
 * Resolves the chosen period against `anchor` (the default "This Month" --
 * the latest month with data for the current scope) and, for "Custom Range",
 * the month the URL names.
 */
export function resolvePnlPeriod(key: PnlPeriodKey, anchor: LedgerMonth, customMonth: LedgerMonth | null): PnlPeriod {
  switch (key) {
    case "this_month":
      return { key, from: anchor.from, to: anchor.to, label: anchor.label }
    case "last_month": {
      const m = previousLedgerMonth(anchor)
      return { key, from: m.from, to: m.to, label: m.label }
    }
    case "this_quarter":
      return quarterOf(anchor)
    case "this_year":
      return yearOf(anchor)
    case "custom": {
      const m = customMonth ?? anchor
      return { key, from: m.from, to: m.to, label: m.label }
    }
  }
}

/**
 * "vs Aug 2026" / "vs Q2 2026" / "vs 2025": the words for the period a
 * `PnlPeriod` is compared against. Shifts back by the SAME whole number of
 * months the period itself spans, mirroring `pnl_summary_change()`'s (0061)
 * own SQL alignment rule exactly, so the label on screen never disagrees
 * with what the database actually compared against.
 */
export function previousPeriodLabel(period: PnlPeriod): string {
  const from = new Date(period.from)
  const to = new Date(period.to)
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  const prevFrom = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months, 1))
  const prevLastMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1))

  if (months <= 1) return MONTH_SHORT_YEAR.format(prevFrom)
  if (months === 3) {
    const q = Math.floor(prevFrom.getUTCMonth() / 3) + 1
    return `Q${q} ${prevFrom.getUTCFullYear()}`
  }
  if (months === 12) return String(prevFrom.getUTCFullYear())
  return `${MONTH_SHORT.format(prevFrom)} – ${MONTH_SHORT_YEAR.format(prevLastMonth)}`
}

/** A period behaves exactly like today's single-month view when it spans one calendar month. */
export function isSingleMonthPeriod(period: PnlPeriod): boolean {
  const from = new Date(period.from)
  const to = new Date(period.to)
  return (
    from.getUTCDate() === 1 &&
    to.getUTCFullYear() * 12 + to.getUTCMonth() === from.getUTCFullYear() * 12 + from.getUTCMonth() + 1
  )
}

export { parseLedgerMonth }
