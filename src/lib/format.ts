/**
 * Display formatting.
 *
 * IMPORTANT: these functions format values FOR DISPLAY ONLY. They convert a
 * `numeric` string into a number to hand it to `Intl.NumberFormat`, which is
 * safe because the result is immediately rendered as text and rounded anyway.
 *
 * Never use this conversion as a step towards arithmetic. Every business
 * figure is calculated in SQL, in exact decimal, before it reaches here.
 */

/** Formats money in the business's own currency. */
export function formatMoney(
  value: string | number | null | undefined,
  currency: string,
  options: { compact?: boolean } = {}
): string {
  const amount = toNumber(value)
  if (amount === null) return "—"

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: options.compact ? "compact" : "standard",
      maximumFractionDigits: options.compact ? 1 : 2,
      minimumFractionDigits: options.compact ? 0 : 2,
    }).format(amount)
  } catch {
    // An unrecognised ISO code should degrade, not crash the dashboard.
    return `${currency} ${amount.toFixed(2)}`
  }
}

/** Formats a plain count or quantity. */
export function formatNumber(
  value: string | number | null | undefined,
  maximumFractionDigits = 0
): string {
  const amount = toNumber(value)
  if (amount === null) return "—"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(amount)
}

/** Formats a percentage that the database already calculated. */
export function formatPercent(value: string | number | null | undefined): string {
  const amount = toNumber(value)
  if (amount === null) return "—"
  return `${amount.toFixed(1)}%`
}

/**
 * Percentage change between two periods.
 *
 * Returns null when there is no meaningful comparison — a previous value of
 * zero has no percentage change, and rendering "+100%" or "∞" there would be
 * an invented figure. The interface says "no prior data" instead.
 */
export function percentChange(
  current: string | number | null | undefined,
  previous: string | number | null | undefined
): number | null {
  const now = toNumber(current)
  const before = toNumber(previous)

  if (now === null || before === null) return null
  if (before === 0) return null

  return ((now - before) / Math.abs(before)) * 100
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
