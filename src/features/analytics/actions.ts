"use server"

import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import {
  briefForPeriod,
  explainMetric,
  explainPeriod,
  type BriefResult,
  type Narration,
} from "@/services/ai"
import { getAnalytics, METRICS } from "@/services/analytics"

import { channelFromParams, scopeFor } from "./dashboard-params"
import { periodFromParams } from "./page-context"

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

/**
 * The filters, exactly as the dashboard puts them in the URL.
 *
 * They are re-read here with the same functions the page uses, so the brief
 * describes the figures on screen rather than a different slice of the
 * business. Every value is a filter, never a figure.
 */
const requestSchema = z.object({
  range: z.string().max(40).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  channel: z.string().max(40).optional(),
})

const metricRequestSchema = requestSchema.extend({
  /** An analytics metric key. Checked against the registry, not just typed. */
  metric: z.string().min(1).max(60),
})

type Filters = z.infer<typeof requestSchema>

/** Loads the same bundle the dashboard is showing, for the same business. */
async function loadContext(filters: Filters) {
  const business = await getActiveBusiness()
  if (!business) return { ok: false as const, error: "No business selected." }

  // The same two functions the dashboard uses. A second interpretation of
  // `?channel=` here would let the brief describe a different slice from the
  // one on screen, which is worse than no brief at all.
  const period = periodFromParams(filters)
  const choice = channelFromParams(filters)
  const scope = scopeFor(choice)

  const analytics = await getAnalytics(business.id, period, business.currency, { scope })

  if (analytics.error !== null) {
    return { ok: false as const, error: "Those figures could not be calculated." }
  }

  const channelScoped = scope.kind !== "all"
  const scopeLabel =
    choice.kind === "unattributed"
      ? "only the orders with no channel recorded"
      : choice.kind === "channel"
        ? `only the ${analytics.channels[0]?.channel_name ?? "selected"} channel`
        : "the whole business"

  return {
    ok: true as const,
    input: {
      businessName: business.name,
      currency: business.currency,
      periodLabel: period.label,
      comparisonLabel: period.comparisonLabel,
      scopeLabel,
      channelScoped,
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

  const context = await loadContext(parsed.data)
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

  const context = await loadContext(parsed.data)
  if (!context.ok) {
    return { ok: false, reason: "refused", message: context.error }
  }

  return explainMetric(definition.label, context.input)
}

/**
 * The dashboard's brief: what happened, why it matters, what to watch, what to
 * do next.
 *
 * Same guarantees as every other AI call here -- the figures are fetched
 * server-side for the business in the session, the reply is checked against
 * them, and an unavailable model is an ordinary outcome that leaves the
 * dashboard intact.
 */
export async function briefForPeriodAction(rawInput: unknown): Promise<BriefResult> {
  const parsed = requestSchema.safeParse(rawInput ?? {})
  if (!parsed.success) {
    return { ok: false, reason: "refused", message: "That request could not be read." }
  }

  const context = await loadContext(parsed.data)
  if (!context.ok) {
    return { ok: false, reason: "refused", message: context.error }
  }

  // Nothing to brief on. Asking a model to find meaning in an empty period is
  // exactly how an invented figure appears.
  if (!context.hasSales) {
    return {
      ok: false,
      reason: "refused",
      message: "There are no sales in this period to explain.",
    }
  }

  return briefForPeriod(context.input)
}
