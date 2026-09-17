/**
 * The number guard.
 *
 * A prompt that says "do not invent figures" is a request. This is the
 * enforcement.
 *
 * HOW IT WORKS
 * ------------
 * The model is given a fact sheet: a block of text containing every figure
 * BizMind computed. After it replies, every number in its reply is checked
 * against the numbers in that sheet. A number that was not in the sheet is a
 * number we never gave it, which means it came from somewhere else -- and
 * there is nowhere else it could legitimately have come from.
 *
 * When that happens the whole reply is discarded. Not edited, not annotated:
 * discarded. A paragraph containing one invented figure is not salvageable,
 * because the invented figure is usually load-bearing for the sentence around
 * it, and an owner reading a confident explanation has no way to tell which
 * half to believe.
 *
 * The dashboard then shows what it always shows: the figures themselves, and
 * the deterministic findings from the analytics engine. Losing an explanation
 * costs an owner a paragraph. A wrong profit figure stated confidently costs
 * them a decision.
 *
 * WHY STRICT IS THE RIGHT DIRECTION
 * ---------------------------------
 * The guard will occasionally reject a harmless sentence -- a model writing
 * "the top 3 channels" when 3 was not a figure we supplied. That is a fair
 * trade. A false rejection loses prose; a false acceptance loses trust.
 */

/**
 * Numbers that carry no financial claim.
 *
 * Only these two, and only because they appear in ordinary English inside
 * sentences that are not about money: "the first thing to fix", "one order".
 * Anything larger has to come from the fact sheet.
 */
const ALWAYS_ALLOWED = new Set(["0", "1"])

export type GuardResult =
  | { ok: true; text: string }
  | {
      ok: false
      /** Every number in the reply that was not in the fact sheet. */
      invented: string[]
      /** Safe to log. Never shown to an owner as though it were an answer. */
      text: string
    }

/**
 * Every numeric token in a string, normalised for comparison.
 *
 * Handles the forms a model actually writes: 9,550.50 · 51.3% · AED 1,234
 * · 12.00 · 1.234,56 is NOT handled, because the fact sheet is rendered with
 * `Intl.NumberFormat("en-US")`, so the model only ever sees en-US grouping.
 */
export function extractNumbers(text: string): string[] {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g)
  if (matches === null) return []
  return matches.map(normalise)
}

/**
 * Reduces a written number to a comparable form.
 *
 *   "9,550.50" -> "9550.5"
 *   "9550.5000" -> "9550.5"
 *   "51.0"     -> "51"
 *
 * Trailing zeros go because a model may write 9,550.5 for a figure the sheet
 * rendered as 9,550.50. Those are the same number, and rejecting one for the
 * other would be pedantry rather than protection.
 */
export function normalise(token: string): string {
  const withoutGrouping = token.replace(/,/g, "")

  if (!withoutGrouping.includes(".")) return stripLeadingZeros(withoutGrouping)

  const trimmed = withoutGrouping.replace(/0+$/, "").replace(/\.$/, "")
  return stripLeadingZeros(trimmed === "" ? "0" : trimmed)
}

function stripLeadingZeros(value: string): string {
  const stripped = value.replace(/^0+(?=\d)/, "")
  return stripped === "" ? "0" : stripped
}

/**
 * Builds the set of numbers a reply is allowed to contain.
 *
 * Taken from the rendered fact sheet itself rather than from the structured
 * figures, which is the point: whatever we showed the model, it may repeat.
 * Dates, counts, percentages and labels are all covered automatically, because
 * they were all in the text we sent.
 *
 * Rounded forms are added too. A sheet saying 51.3% may fairly be described as
 * 51%, and a model that rounds is being readable, not inventive.
 */
export function buildAllowlist(factSheetText: string): Set<string> {
  const allowed = new Set<string>(ALWAYS_ALLOWED)

  for (const token of extractNumbers(factSheetText)) {
    allowed.add(token)

    const value = Number(token)
    if (!Number.isFinite(value)) continue

    // Rounded and truncated forms of the same figure.
    allowed.add(normalise(String(Math.round(value))))
    allowed.add(normalise(value.toFixed(1)))
    allowed.add(normalise(value.toFixed(2)))
    allowed.add(normalise(String(Math.trunc(value))))
  }

  return allowed
}

/**
 * Checks a reply against the facts it was given.
 *
 * Returns the text unchanged when every number in it came from the sheet, and
 * the list of invented numbers when it did not.
 */
export function guardNumbers(reply: string, factSheetText: string): GuardResult {
  const allowed = buildAllowlist(factSheetText)

  const invented = [...new Set(extractNumbers(reply))].filter(
    (token) => !allowed.has(token)
  )

  if (invented.length > 0) return { ok: false, invented, text: reply }
  return { ok: true, text: reply }
}

/**
 * Refuses a reply that claims to have calculated something.
 *
 * The number guard catches a wrong figure. This catches the other failure: a
 * reply whose numbers are all real but which presents itself as having done
 * the working -- "adding these up gives", "which works out to". BizMind's
 * credibility rests on figures coming from the database, so an explanation
 * must never imply they came from a model instead.
 */
const CALCULATION_CLAIMS = [
  /\bI calculated\b/i,
  /\bI computed\b/i,
  /\bI worked out\b/i,
  /\badding (?:these|those|them) up\b/i,
  /\bwhich works out to\b/i,
  /\bmy calculation\b/i,
  /\bif we multiply\b/i,
  /\bif we divide\b/i,
]

export function claimsToCalculate(reply: string): boolean {
  return CALCULATION_CLAIMS.some((pattern) => pattern.test(reply))
}

/**
 * Refuses a reply that has drifted into advice BizMind must not give.
 *
 * V1 does not act on the owner's behalf and does not give regulated advice.
 * A model asked to be helpful will sometimes offer both.
 */
const OUT_OF_SCOPE = [
  // "I have updated" and "I've updated" both. The first version of this
  // required a space before the contraction, so "I've" slipped straight past.
  /\bI(?:\s+have|'ve)\s+(?:now\s+)?(?:updated|changed|created|deleted|sent|ordered|placed)\b/i,
  /\byou should (?:invest|borrow)\b/i,
  /\btax (?:advice|liability|return)\b/i,
]

export function claimsToAct(reply: string): boolean {
  return OUT_OF_SCOPE.some((pattern) => pattern.test(reply))
}

/**
 * Refuses a reply that treats an expected payout as money received (GCC
 * Phase 9). No bank source is connected, so BizMind cannot know what reached
 * the bank, and an owner told otherwise may spend money that has not arrived.
 *
 * Deliberately strict: a sentence that merely brushes against these phrases
 * loses the paragraph, which is the right direction to fail in.
 */
const RECEIPT_CLAIMS = [
  /\byou(?:'ve| have)?\s+(?:already\s+)?received\b/i,
  /\b(?:has|have|had|was|were)\s+(?:already\s+)?(?:been\s+)?(?:received|deposited|credited|paid into)\b/i,
  /\b(?:reached|landed in|arrived in|deposited (?:in|into)|credited to)\s+your (?:bank|account)\b/i,
  /\bin your bank(?: account)? (?:now|already)\b/i,
]

export function claimsMoneyReceived(reply: string): boolean {
  return RECEIPT_CLAIMS.some((pattern) => pattern.test(reply))
}

/**
 * Refuses a reply that calls a not-final figure final (GCC Phase 9).
 * Only applied when the facts contain a figure that is NOT FINAL.
 */
const FINALITY_CLAIMS = [
  /\b(?:your|the)\s+(?:final|confirmed)\s+(?:contribution|gross profit|net profit|profit)\b/i,
  /\b(?:contribution|gross profit|net profit|profit)\s+(?:is|was)\s+(?:final|confirmed)\b/i,
]

export function claimsFinality(reply: string): boolean {
  return FINALITY_CLAIMS.some((pattern) => pattern.test(reply))
}
