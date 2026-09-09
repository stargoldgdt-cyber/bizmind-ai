"use server"

import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { explainMetric, explainPeriod, type Narration } from "@/services/ai"
import {
  DEFAULT_PERIOD,
  getAnalytics,
  isPeriodKey,
  METRICS,
  resolvePeriod,
} from "@/services/analytics"

/**
 * Server actions for the AI analyst.
 *
 * THE FIGURES ARE NEVER ACCEPTED FROM THE CLIENT.
 *
 * These actions take a period key and nothing else. Everything the model is
 * shown is fetched here, server-side, from the analytics engine, for the
 * business resolved from the session.
 *
 * That is the whole security design. If the browser could post the numbers to
 * be explained, a tampered request could have BizMind narrate figures that
 * were never in anyone's records -- and the resulting paragraph would look
 * exactly like a real one, because it would be a real one, about invented
 * inputs.
 *
 * No arithmetic happens here either. This action fetches verified figures and
 * hands them on.
 */

const requestSchema = z.object({
  range: z.string().max(40).optional(),
})

const metricRequestSchema = requestSchema.extend({
  /** An analytics metric key. Checked against the registry, not just typed. */
  metric: z.string().min(1).max(60),
})

/** Loads the same bundle the dashboard is showing, for the same business. */
async function loadContext(range: string | undefined) {
  const business = await getActiveBusiness()
  if (!business) return { ok: false as const, error: "No business selected." }

  const period = resolvePeriod(isPeriodKey(range) ? range : DEFAULT_PERIOD)
  const analytics = await getAnalytics(business.id, period, business.currency)

  if (analytics.error !== null) {
    return { ok: false as const, error: "Those figures could not be calculated." }
  }

  return {
    ok: true as const,
    input: {
      businessName: business.name,
      currency: business.currency,
      periodLabel: period.label,
      comparisonLabel: period.comparisonLabel,
      periodIncomplete: period.incomplete,
      current: analytics.current,
      comparisons: analytics.comparisons,
      channels: analytics.channels,
      products: analytics.products,
      health: analytics.health,
      insights: analytics.insights,
    },
    hasSales: analytics.current.orders_count > 0,
  }
}

export async function explainPeriodAction(rawInput: unknown): Promise<Narration> {
  const parsed = requestSchema.safeParse(rawInput ?? {})
  if (!parsed.success) {
    return { ok: false, reason: "refused", message: "That request could not be read." }
  }

  const context = await loadContext(parsed.data.range)
  if (!context.ok) {
    return { ok: false, reason: "refused", message: context.error }
  }

  // Nothing to explain, and asking a model to find meaning in an empty period
  // is exactly how an invented one appears.
  if (!context.hasSales) {
    return {
      ok: false,
      reason: "refused",
      message: "There are no sales in this period to explain.",
    }
  }

  return explainPeriod(context.input)
}

export async function explainMetricAction(rawInput: unknown): Promise<Narration> {
  const parsed = metricRequestSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, reason: "refused", message: "That request could not be read." }
  }

  // The label the model is asked about comes from OUR registry, looked up by
  // key -- never from the request body. A free-text label would be a way to
  // put words in the model's mouth.
  const definition = METRICS[parsed.data.metric]
  if (definition === undefined) {
    return { ok: false, reason: "refused", message: "That is not a BizMind figure." }
  }

  const context = await loadContext(parsed.data.range)
  if (!context.ok) {
    return { ok: false, reason: "refused", message: context.error }
  }

  return explainMetric(definition.label, context.input)
}
