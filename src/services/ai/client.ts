import "server-only"

/**
 * The ONLY place in BizMind that talks to OpenAI.
 *
 * Nothing else in the codebase calls a language model, directly or indirectly.
 * That is not a style preference: it means the rules below cannot be bypassed
 * by adding a feature somewhere else, because there is only one door.
 *
 * NO SDK, DELIBERATELY
 * --------------------
 * This is one HTTP POST. A dependency would add a supply-chain surface and a
 * second thing to keep current, in exchange for retries we want to control
 * ourselves. See DECISIONS.md.
 *
 * THE KEY
 * -------
 * `OPENAI_API_KEY` is read here, on the server, and nowhere else. It is not in
 * `src/lib/env.ts` with the public values, so there is no path by which it can
 * be pulled into a browser bundle. A missing key is not an error: it means the
 * AI layer is unavailable, and every feature that uses it must already work
 * without it.
 */

/** Why a request could not be made or could not be trusted. */
export type AiUnavailableReason =
  | "not_configured"
  /** The account has no credit. Waiting will never fix this. */
  | "no_credit"
  /** Genuinely too many requests too quickly. Waiting WILL fix this. */
  | "rate_limited"
  | "timed_out"
  | "refused"
  | "failed"

export type AiResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: AiUnavailableReason; detail: string }

/**
 * Default model.
 *
 * Overridable with `OPENAI_MODEL` because model names change faster than this
 * codebase will. `npm run ai:check` verifies that whatever is configured
 * actually exists on the account, AND that it is the model which actually
 * answered -- asking for one model and being served another is a real failure
 * mode, and a key that merely works proves nothing about which model replied.
 */
const DEFAULT_MODEL = "gpt-5.6-terra"

const ENDPOINT = "https://api.openai.com/v1/chat/completions"

/** An owner waiting on a dashboard will not wait longer than this. */
const TIMEOUT_MS = 20_000

export function aiModel(): string {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL
}

/** Whether the AI layer is configured at all. Never throws. */
export function isAiConfigured(): boolean {
  return (process.env.OPENAI_API_KEY?.trim().length ?? 0) > 20
}

export type CompletionRequest = {
  system: string
  user: string
  /** Hard cap. These are short explanations, not essays. */
  maxOutputTokens?: number
  /**
   * Omitted unless set. Newer models accept only their default temperature and
   * reject anything else outright, so sending a value BizMind does not need
   * would tie the product to one generation of model.
   *
   * The determinism that matters here did not come from temperature anyway. It
   * came from computing the figures the explanation needs, so there is nothing
   * left for a model to be creative about. See migration 0010.
   */
  temperature?: number
}

/**
 * Sends one request and returns text, or a reason it could not.
 *
 * NEVER THROWS. Every caller is rendering something an owner is waiting for,
 * and a language model being slow or down must degrade to the plain figures,
 * not to an error page.
 */
export async function complete(request: CompletionRequest): Promise<AiResult> {
  const key = process.env.OPENAI_API_KEY?.trim()

  if (!key || key.length <= 20) {
    return {
      ok: false,
      reason: "not_configured",
      detail: "No OpenAI key is configured, so explanations are turned off.",
    }
  }

  const model = aiModel()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: request.maxOutputTokens ?? 700,
        ...(request.temperature === undefined
          ? {}
          : { temperature: request.temperature }),
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    })

    // OpenAI returns 429 for two completely different situations, and the
    // right response to each is the opposite of the other: one clears by
    // waiting, the other never does. Telling an owner to "try again shortly"
    // when their account is out of credit wastes their afternoon.
    if (response.status === 429) {
      const body = await response.text()

      if (/insufficient_quota|credit_balance_exhausted|billing/i.test(body)) {
        return {
          ok: false,
          reason: "no_credit",
          detail: "The OpenAI account has no credit remaining.",
        }
      }

      return {
        ok: false,
        reason: "rate_limited",
        detail: "Too many requests to OpenAI in a short time.",
      }
    }

    if (!response.ok) {
      // The body can contain the request payload back. It is logged for an
      // operator, never returned to the browser.
      const body = await response.text()
      console.error(`[ai] ${response.status} from OpenAI: ${body.slice(0, 400)}`)
      return {
        ok: false,
        reason: "failed",
        detail: `OpenAI returned ${response.status}.`,
      }
    }

    const json: unknown = await response.json()
    const text = extractText(json)

    if (text === null || text.trim() === "") {
      return { ok: false, reason: "failed", detail: "OpenAI returned no text." }
    }

    // The model named in the RESPONSE, not the one in the request. A provider
    // is free to serve a different or dated build than the alias asked for,
    // and "the key works" says nothing about which model actually answered.
    return { ok: true, text: text.trim(), model: respondingModel(json) ?? model }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        reason: "timed_out",
        detail: `No response within ${TIMEOUT_MS / 1000} seconds.`,
      }
    }

    console.error("[ai] request failed", error)
    return { ok: false, reason: "failed", detail: "The request could not be completed." }
  } finally {
    clearTimeout(timer)
  }
}

/** The model OpenAI says produced this reply. Null if it did not say. */
function respondingModel(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null
  const model = (json as { model?: unknown }).model
  return typeof model === "string" && model !== "" ? model : null
}

/**
 * Pulls the message text out of a response.
 *
 * Written defensively and without `any`: this is the boundary with someone
 * else's API, and a shape change should degrade rather than throw.
 */
function extractText(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null

  const choices = (json as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null

  const message = (choices[0] as { message?: unknown }).message
  if (typeof message !== "object" || message === null) return null

  const content = (message as { content?: unknown }).content
  return typeof content === "string" ? content : null
}
