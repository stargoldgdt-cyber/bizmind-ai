import "server-only"

/**
 * The AI business analyst.
 *
 * COMPUTE FIRST, THEN NARRATE.
 *
 * Every figure comes from the analytics engine. This layer turns those figures
 * into a paragraph an owner can act on, and refuses to publish anything it
 * cannot vouch for.
 *
 * The pipeline, and every step of it can fail safely:
 *
 *   analytics bundle  ->  fact sheet  ->  model  ->  guard  ->  narration
 *        (verified)       (formatted)    (prose)   (checked)     or nothing
 *
 * "or nothing" is a first-class outcome, not an error. The dashboard shows the
 * figures and the deterministic findings whether or not this layer produces a
 * single word.
 */

import { complete, isAiConfigured, type AiUnavailableReason } from "./client"
import { buildFactSheet, renderFactSheet, type FactSheetInput } from "./facts"
import { claimsToAct, claimsToCalculate, guardNumbers } from "./guard"
import {
  briefSystemPrompt,
  briefUserPrompt,
  explainSystemPrompt,
  explainUserPrompt,
  narrativeSystemPrompt,
  narrativeUserPrompt,
} from "./prompts"

/** Why there is no explanation. Every one of these is shown plainly. */
export type SuppressionReason =
  | AiUnavailableReason
  | "invented_figures"
  | "claimed_to_calculate"
  | "out_of_scope"
  | "wrong_shape"

export type Narration =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: SuppressionReason; message: string }

/**
 * What an owner is told when there is no explanation.
 *
 * Each one says what happened and, crucially, that the figures themselves are
 * unaffected. Silence would invite the assumption that something is wrong with
 * the numbers.
 */
const MESSAGES: Record<SuppressionReason, string> = {
  not_configured:
    "Written explanations are switched off. Your figures above are unaffected.",
  no_credit:
    "Written explanations are paused because the OpenAI account has run out of credit. Adding credit switches them back on. Your figures above are unaffected.",
  rate_limited:
    "Explanations are busy at the moment. Try again shortly. Your figures above are unaffected.",
  timed_out:
    "The explanation took too long and was cancelled. Your figures above are unaffected.",
  refused: "No explanation was produced. Your figures above are unaffected.",
  failed:
    "The explanation could not be produced just now. Your figures above are unaffected.",
  invented_figures:
    "An explanation was produced but it contained a figure that is not in your records, so it was discarded. This is deliberate: BizMind will not show you a number it cannot trace. Your figures above are unaffected.",
  claimed_to_calculate:
    "An explanation was discarded because it described working out figures itself. Every figure in BizMind is calculated from your records, never by the writing. Your figures above are unaffected.",
  out_of_scope:
    "An explanation was discarded because it strayed into advice BizMind does not give. Your figures above are unaffected.",
  wrong_shape:
    "An explanation was produced but not in the form BizMind publishes, so it was discarded. Your figures above are unaffected.",
}

/** The shape both features share when there is nothing to show. */
type Suppressed = { ok: false; reason: SuppressionReason; message: string }

function suppress(reason: SuppressionReason): Suppressed {
  return { ok: false, reason, message: MESSAGES[reason] }
}

/**
 * Runs one request and puts the reply through every check.
 *
 * Shared by both features so a new feature cannot accidentally skip a check by
 * calling the client directly. `client.ts` is the only door out; this is the
 * only door through.
 */
async function narrate(
  system: string,
  user: string,
  factSheetText: string,
  maxOutputTokens: number
): Promise<Narration> {
  if (!isAiConfigured()) return suppress("not_configured")

  const result = await complete({ system, user, maxOutputTokens })
  if (!result.ok) return suppress(result.reason)

  // Order matters only for what gets logged. Any one of these discards it.
  const guarded = guardNumbers(result.text, factSheetText)
  if (!guarded.ok) {
    console.warn(
      `[ai] discarded a reply containing figures that were not in the facts: ` +
        `${guarded.invented.join(", ")}`
    )
    return suppress("invented_figures")
  }

  if (claimsToCalculate(result.text)) {
    console.warn("[ai] discarded a reply that described calculating figures itself")
    return suppress("claimed_to_calculate")
  }

  if (claimsToAct(result.text)) {
    console.warn("[ai] discarded a reply that claimed to act or gave regulated advice")
    return suppress("out_of_scope")
  }

  return { ok: true, text: result.text, model: result.model }
}

/**
 * "What happened this period, and what should I do about it?"
 *
 * The headline feature. Explains the computed figures and the deterministic
 * findings; invents neither.
 */
export async function explainPeriod(input: FactSheetInput): Promise<Narration> {
  const sheet = buildFactSheet(input)
  const text = renderFactSheet(sheet)

  return narrate(narrativeSystemPrompt(), narrativeUserPrompt(text), text, 700)
}

/** "What does this figure actually mean?" for one metric. */
export async function explainMetric(
  metricLabel: string,
  input: FactSheetInput
): Promise<Narration> {
  const sheet = buildFactSheet(input)
  const text = renderFactSheet(sheet)

  return narrate(
    explainSystemPrompt(),
    explainUserPrompt(metricLabel, text),
    text,
    300
  )
}

/* ==========================================================================
 * THE BUSINESS BRIEF
 * ==========================================================================
 *
 * The same pipeline, with one more step: the reply has to arrive in the shape
 * the dashboard publishes, or it is discarded.
 *
 *   WHAT HAPPENED    the figures, and which way they moved
 *   WHY IT MATTERS   what is behind the movement, in money
 *   WHAT TO WATCH    what could change it, and how far to trust it
 *   WHAT TO DO NEXT  one to three things the owner can do this week
 *
 * Four sections rather than four paragraphs because an owner skims. A brief
 * whose caveat is buried mid-paragraph gets acted on without the caveat, which
 * is the failure this product exists to prevent.
 * ======================================================================== */

export type BusinessBrief = {
  happened: string
  matters: string
  watch: string
  /** One to three actions. Never empty: a brief with no next step is discarded. */
  next: string[]
}

export type BriefResult =
  | { ok: true; brief: BusinessBrief; model: string }
  | { ok: false; reason: SuppressionReason; message: string }

const HEADINGS = ["WHAT HAPPENED", "WHY IT MATTERS", "WHAT TO WATCH", "WHAT TO DO NEXT"] as const

/**
 * Splits a reply into its four sections.
 *
 * Tolerant about decoration (a stray `#`, `**` or trailing colon on a heading
 * line) and unforgiving about substance: all four headings, in order, each
 * with something under it, and at least one action. Anything else returns null
 * and the brief is suppressed rather than half-rendered.
 *
 * It never repairs a reply. A missing section means the model did not do the
 * job, and inventing the missing part here would be this module writing the
 * business's brief itself.
 */
export function parseBrief(text: string): BusinessBrief | null {
  const positions = HEADINGS.map((heading) => {
    const pattern = new RegExp(`^[#*\\s]*${heading}[:*\\s]*$`, "im")
    const match = pattern.exec(text)
    return match === null ? null : { start: match.index, end: match.index + match[0].length }
  })

  if (positions.some((position) => position === null)) return null

  const found = positions as { start: number; end: number }[]

  // In order, and not the same line matched twice.
  for (let index = 1; index < found.length; index += 1) {
    if (found[index].start <= found[index - 1].start) return null
  }

  const body = (index: number) =>
    text
      .slice(found[index].end, index + 1 < found.length ? found[index + 1].start : text.length)
      .trim()

  const happened = body(0)
  const matters = body(1)
  const watch = body(2)
  const next = body(3)
    .split("\n")
    .map((line) => line.replace(/^[-*•\s]+/, "").trim())
    .filter((line) => line !== "")
    .slice(0, 3)

  if (happened === "" || matters === "" || watch === "" || next.length === 0) return null

  return { happened, matters, watch, next }
}

/**
 * "What happened, why it matters, what to watch, what to do next."
 *
 * The dashboard's analyst. Every figure it may mention is in the fact sheet,
 * every figure it does mention is checked against it, and the shape is checked
 * on top of that.
 */
export async function briefForPeriod(input: FactSheetInput): Promise<BriefResult> {
  const sheet = buildFactSheet(input)
  const text = renderFactSheet(sheet)

  const narration = await narrate(briefSystemPrompt(), briefUserPrompt(text), text, 800)
  if (!narration.ok) return { ok: false, reason: narration.reason, message: narration.message }

  const brief = parseBrief(narration.text)
  if (brief === null) {
    console.warn("[ai] discarded a brief that did not carry all four sections")
    return suppress("wrong_shape")
  }

  return { ok: true, brief, model: narration.model }
}
