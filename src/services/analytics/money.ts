/**
 * Exact decimal handling for money, without arithmetic.
 *
 * Money crosses the boundary from PostgreSQL as an exact decimal STRING --
 * "9550.5000", "-3861.6100" -- because migration 0011 casts it to text in SQL,
 * while it is still exact. Nothing in TypeScript converts it back.
 *
 * That leaves one thing the application legitimately needs and could not
 * otherwise do: put two figures in order. Sorting channels by revenue is not a
 * financial calculation, but the obvious implementation --
 *
 *     .sort((a, b) => Number(b.revenue) - Number(a.revenue))
 *
 * -- is. It converts two exact decimals to doubles and subtracts them, which
 * is precisely what the whole boundary exists to prevent. It also happens to
 * be wrong for figures that differ only beyond a double's 15-17 significant
 * digits: `numeric(20,4)` carries 20.
 *
 * So this module compares the DIGITS. No conversion, no operators, no
 * rounding. It is the only file exempted from the money guard, and it earns
 * that by containing no arithmetic to exempt.
 */

/**
 * A money value as it arrives from the database: exact decimal text.
 *
 * `number` is accepted, and never produced. It exists so that a figure which
 * somehow reaches this code as a number -- an analytics function that has not
 * been migrated, a fixture written by hand -- is ordered rather than crashing
 * a dashboard on `.trim()`. Accepting it does not bless it: the boundary test
 * asserts that every money field really is a string at runtime, so a number
 * arriving here fails the suite rather than passing quietly.
 */
type Decimal = string | number | null | undefined

type Parts = { negative: boolean; whole: string; fraction: string }

/**
 * Splits an exact decimal into comparable pieces.
 *
 * Leading zeros go because "007" and "7" are the same number written twice.
 * Trailing zeros in the fraction go for the same reason: PostgreSQL returns
 * "1000.1000" and "1000.10" for values that are equal, and a comparison that
 * called them different would be comparing formatting, not money.
 */
function split(value: string): Parts {
  const trimmed = value.trim()
  const negative = trimmed.startsWith("-")
  const body = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed

  const dot = body.indexOf(".")
  const whole = dot === -1 ? body : body.slice(0, dot)
  const fraction = dot === -1 ? "" : body.slice(dot + 1)

  return {
    negative,
    whole: whole.replace(/^0+(?=\d)/, "") || "0",
    fraction: fraction.replace(/0+$/, ""),
  }
}

/** Compares two non-negative magnitudes. Digits only. */
function compareMagnitude(a: Parts, b: Parts): number {
  // A longer whole part is a larger number, once leading zeros are gone.
  if (a.whole.length !== b.whole.length) {
    return a.whole.length > b.whole.length ? 1 : -1
  }
  if (a.whole !== b.whole) return a.whole > b.whole ? 1 : -1

  // Same integer part: pad the fractions and compare them as digit strings.
  const width = Math.max(a.fraction.length, b.fraction.length)
  const left = a.fraction.padEnd(width, "0")
  const right = b.fraction.padEnd(width, "0")

  if (left === right) return 0
  return left > right ? 1 : -1
}

/**
 * Orders two money figures. Exact for every value `numeric(20,4)` can hold.
 *
 * Returns a negative number, zero, or a positive number, so it can be handed
 * straight to `Array.prototype.sort`.
 *
 * A null or missing figure sorts LAST in a descending sort. "Not recorded" is
 * not the same as zero, and a channel whose revenue is unknown should not be
 * presented as the smallest one.
 */
export function compareMoney(a: Decimal, b: Decimal): number {
  const aText = a === null || a === undefined ? "" : String(a).trim()
  const bText = b === null || b === undefined ? "" : String(b).trim()

  if (aText === "" && bText === "") return 0
  if (aText === "") return -1
  if (bText === "") return 1

  const left = split(aText)
  const right = split(bText)

  // Zero has no sign. "-0.0000" and "0" are the same figure.
  const leftZero = left.whole === "0" && left.fraction === ""
  const rightZero = right.whole === "0" && right.fraction === ""
  if (leftZero && rightZero) return 0

  const leftNegative = left.negative && !leftZero
  const rightNegative = right.negative && !rightZero

  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1

  const magnitude = compareMagnitude(left, right)
  return leftNegative ? -magnitude : magnitude
}

/** Largest first. Missing figures sort to the end. */
export function byMoneyDescending(a: Decimal, b: Decimal): number {
  return compareMoney(b, a)
}

/** Whether a figure is greater than zero. A comparison, not a calculation. */
export function isPositiveMoney(value: Decimal): boolean {
  return compareMoney(value, "0") > 0
}

/** Whether the database recorded an explicit zero -- not the same as unknown. */
export function isZeroMoney(value: Decimal): boolean {
  if (value === null || value === undefined) return false
  if (String(value).trim() === "") return false
  return compareMoney(value, "0") === 0
}
