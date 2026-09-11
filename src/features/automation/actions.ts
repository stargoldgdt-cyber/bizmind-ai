"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import {
  acknowledgeAlert,
  createRuleFromTemplate,
  evaluateBusinessNow,
  setRuleEnabled,
} from "@/services/automation"

/**
 * Server actions for alerts and rules.
 *
 * THE BUSINESS IS NEVER ACCEPTED FROM THE CLIENT.
 *
 * Every action takes an id and nothing else. `alert_acknowledge()` is
 * SECURITY INVOKER, so Row Level Security scopes it: an alert belonging to
 * another business is simply not found, and the caller cannot tell the
 * difference between "not yours" and "does not exist" — which is the correct
 * answer to both.
 *
 * "Run my rules" is the one action that takes a business id, and it resolves
 * that from the session here rather than from the form. The database function
 * re-checks membership anyway; this is the belt to its braces.
 */

const idSchema = z.object({ id: z.uuid() })

export type ActionResult = { ok: true } | { ok: false; error: string }

export async function acknowledgeAlertAction(
  rawInput: unknown
): Promise<ActionResult> {
  const parsed = idSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That alert could not be read." }

  const result = await acknowledgeAlert(parsed.data.id)
  if (!result.ok) return result

  revalidatePath("/alerts")
  return { ok: true }
}

export async function setRuleEnabledAction(
  rawInput: unknown
): Promise<ActionResult> {
  const parsed = idSchema.extend({ enabled: z.boolean() }).safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That change could not be read." }

  const result = await setRuleEnabled(parsed.data.id, parsed.data.enabled)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath("/alerts")
  return { ok: true }
}

export async function addRuleFromTemplateAction(
  rawInput: unknown
): Promise<ActionResult> {
  const parsed = z
    .object({ templateId: z.string().min(1).max(60) })
    .safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That rule could not be read." }

  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  const result = await createRuleFromTemplate(business.id, parsed.data.templateId)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath("/alerts")
  return { ok: true }
}

/**
 * Checks every rule now.
 *
 * The same database function the scheduled worker uses, so a manual check and
 * an automatic one cannot disagree. It can raise a real alert, which is
 * deliberate: a "test" that could not fire would not be testing anything.
 */
export async function runRulesNowAction(): Promise<
  { ok: true; fired: number } | { ok: false; error: string }
> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  const result = await evaluateBusinessNow(business.id)
  if (!result.ok) return result

  revalidatePath("/alerts")
  return { ok: true, fired: result.fired }
}
