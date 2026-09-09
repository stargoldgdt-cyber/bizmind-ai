/**
 * Display formatting.
 *
 * THESE FUNCTIONS NEVER CONVERT A MONEY VALUE TO A NUMBER.
 *
 * Money reaches the application as an exact decimal string -- "9550.5000",
 * "9007199254740993.0000" -- because migration 0011 casts it to text inside
 * SQL, while it is still exact. The last place that exactness could be lost is
 * here, and for a while it was: this file used to call `Number(value)` before
 * handing the result to `Intl.NumberFormat`, which turned
 * 9007199254740993.0000 into 9,007,199,254,740,992.00 on the way to the
 * screen. The database was right and the dashboard was wrong.
 *
 * `Intl.NumberFormat` accepts a string and formats it as an exact decimal,
 * rounding correctly without ever building a double. So the string is passed
 * straight through. A figure is displayed as the digits the database produced,
 * or not displayed at all.
 *
 * There is no arithmetic in this file. Formatting is not calculation: rounding
 * for display is done by Intl, on the exact value, at the moment of rendering.
 */

/** What is shown when a figure does not exist. Never "0". */
const UNKNOWN = "—"

/**
 * An exact decimal as text, or a plain number for counts.
 *
 * A number is accepted because counts genuinely are numbers. Passing a money
 * value as one is a bug the money-boundary test catches, not something this
 * file can detect.
 */
type Displayable = string | number | null | undefined

/** Digits only, with an optional sign and decimal part. */
const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/

/**
 * What `Intl.NumberFormat.format` accepts.
 *
 * Its string overload is typed as a template-literal type, which TypeScript
 * cannot prove a runtime string satisfies. `displayable()` below checks the
 * shape with `DECIMAL` first, so the assertion states something already
 * verified rather than something hoped for.
 */
type IntlValue = Parameters<Intl.NumberFormat["format"]>[0]

/**
 * Whatever Intl can format exactly, or null if there is nothing to show.
 *
 * An empty string returns null rather than being formatted: `Intl` renders it
 * as 0.00, which would state that a figure nobody recorded is zero.
 */
function displayable(value: Displayable): string | number | null {
  if (value === null || value === undefined) return null

  if (typeof value === "number") return Number.isFinite(value) ? value : null

  const trimmed = value.trim()
  if (trimmed === "") return null
  return DECIMAL.test(trimmed) ? trimmed : null
}

/**
 * Formats money in the business's own currency.
 *
 * The value is passed to Intl exactly as the database produced it, so every
 * digit of a `numeric(20,4)` survives to the screen.
 */
export function formatMoney(
  value: Displayable,
  currency: string,
  options: { compact?: boolean } = {}
): string {
  const amount = displayable(value)
  if (amount === null) return UNKNOWN

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: options.compact ? "compact" : "standard",
      maximumFractionDigits: options.compact ? 1 : 2,
      minimumFractionDigits: options.compact ? 0 : 2,
    }).format(amount as IntlValue)
  } catch {
    // An unrecognised ISO code should degrade, not crash the dashboard. The
    // digits are still shown exactly; only the currency styling is lost.
    return `${currency} ${amount}`
  }
}

/** Formats a plain count or quantity. */
export function formatNumber(value: Displayable, maximumFractionDigits = 0): string {
  const amount = displayable(value)
  if (amount === null) return UNKNOWN

  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(amount as IntlValue)
}

/**
 * Formats a percentage the database already calculated.
 *
 * The rounding is Intl's, applied to the exact value. Nothing here works one
 * out: a percentage shown to an owner is a figure, and figures come from SQL.
 */
export function formatPercent(value: Displayable): string {
  const amount = displayable(value)
  if (amount === null) return UNKNOWN

  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(amount as IntlValue)}%`
}
