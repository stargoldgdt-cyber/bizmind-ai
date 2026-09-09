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
  rate_limited:
    "Explanations are temporarily unavailable because of a usage limit. Your figures above are unaffected.",
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
}

function suppress(reason: SuppressionReason): Narration {
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
