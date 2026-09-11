/**
 * JSON with every number kept exactly as it was written.
 *
 * WHY THIS EXISTS
 * ---------------
 * `JSON.parse` turns every number into an IEEE-754 double before any code sees
 * it. `12345678901234567.89` becomes `12345678901234568`, and there is no
 * getting the original back afterwards: `String(parsed)` prints the double,
 * not what the sender wrote. MONEY.md forbids exactly that conversion, and
 * migration 0011 exists because the database used to do it to us.
 *
 * Google's APIs return spreadsheet numbers as JSON numbers. So a Sheets
 * response is parsed here, where each number is captured as the exact text of
 * its JSON token -- before any double exists.
 *
 * HOW
 * ---
 * Node 24's `JSON.parse` passes a reviver the SOURCE TEXT of each primitive
 * (the "JSON.parse source text access" feature). That text is what we keep.
 * If a runtime ever lacks it, this refuses to parse rather than quietly
 * falling back to lossy numbers -- a silent precision loss is the one outcome
 * worse than an error.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * No arithmetic, and no rounding. An `ExactNumber` is a string with a label on
 * it, so downstream code can tell "this cell held a number" from "this cell
 * held text that looks like one". Money is calculated in SQL.
 */

/** A JSON number, kept as the exact text it arrived as. */
export class ExactNumber {
  constructor(readonly text: string) {
    if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
      throw new TypeError(`Not a JSON number: ${text}`)
    }
  }

  /** The exact digits, never a reformatted double. */
  toString(): string {
    return this.text
  }

  toJSON(): string {
    return this.text
  }
}

export function isExactNumber(value: unknown): value is ExactNumber {
  return value instanceof ExactNumber
}

/**
 * An ExactNumber written out in full: "1.5e3" becomes "1500" and "-2.5E-3"
 * becomes "-0.0025". Only the text is moved around -- no double is ever made,
 * so nothing is rounded.
 *
 * Needed because a JSON number may use exponent form, and neither the
 * database's numeric parser nor a person reading an order ID should meet
 * "1e3". Exponents beyond 1000 are refused: no spreadsheet value is that
 * large, and expanding one would build a string of a thousand zeros.
 */
export function plainDecimal(value: ExactNumber): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.text)
  if (!match) throw new TypeError(`Not a JSON number: ${value.text}`)

  const [, sign, whole, fraction = "", exponentText] = match
  if (exponentText === undefined) return value.text

  const exponent = Number.parseInt(exponentText, 10)
  if (Math.abs(exponent) > 1000) throw new RangeError(`Exponent out of range: ${value.text}`)

  let digits = whole + fraction
  // Where the decimal point falls within `digits`.
  let point = whole.length + exponent

  if (point <= 0) {
    digits = "0".repeat(1 - point) + digits
    point = 1
  } else if (point > digits.length) {
    digits = digits + "0".repeat(point - digits.length)
  }

  const integerPart = digits.slice(0, point).replace(/^0+(?=\d)/, "")
  const fractionPart = digits.slice(point)
  return `${sign}${integerPart}${fractionPart ? `.${fractionPart}` : ""}`
}

export class LossyJsonError extends Error {
  constructor() {
    super(
      "This runtime does not expose JSON source text, so numbers cannot be " +
        "parsed without losing precision. BizMind requires Node.js 24 or later."
    )
    this.name = "LossyJsonError"
  }
}

type SourceReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string }
) => unknown

/**
 * Parses JSON, replacing every number with an `ExactNumber` holding its exact
 * source text. Strings, booleans, null, arrays and objects are unchanged.
 */
export function parseExactJson(text: string): unknown {
  const parse = JSON.parse as (text: string, reviver: SourceReviver) => unknown

  return parse(text, function (_key, value, context) {
    if (typeof value !== "number") return value

    const source = context?.source
    if (typeof source !== "string") throw new LossyJsonError()

    return new ExactNumber(source)
  })
}
