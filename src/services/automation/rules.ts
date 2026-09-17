import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { AutomationRule, AutomationRun } from "@/types/database"

import {
  createRuleSchema,
  updateRuleSchema,
  type CreateRuleInput,
  type UpdateRuleInput,
} from "./contracts"
import { getRuleTemplate } from "./templates"

/**
 * Reading and writing automation rules.
 *
 * Every function here uses the SESSION-SCOPED client, so Row Level Security
 * decides what the caller can see and change: a member reads, an OWNER or
 * ADMIN writes, and a rule belonging to another business is simply not there.
 * None of that is re-implemented in this file, because a check written in
 * TypeScript is a check somebody can forget to write next time.
 *
 * `business_id` is passed in from the caller's resolved session, never from a
 * request body. It narrows the query; it does not grant anything -- if it were
 * ever wrong, the policies would still return nothing.
 */

export type RuleResult =
  | { ok: true; rule: AutomationRule }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }

/** Every rule for a business, newest first. */
export async function listRules(businessId: string): Promise<AutomationRule[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[automation] listRules failed", error.message)
    return []
  }

  return data ?? []
}

export async function getRule(ruleId: string): Promise<AutomationRule | null> {
  const supabase = await createClient()

  const { data } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("id", ruleId)
    .maybeSingle()

  return data ?? null
}

export async function createRule(
  businessId: string,
  input: CreateRuleInput
): Promise<RuleResult> {
  const parsed = createRuleSchema.safeParse(input)

  if (!parsed.success) {
    return {
      ok: false,
      error: "That rule could not be saved.",
      fieldErrors: fieldErrorsOf(parsed.error),
    }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from("automation_rules")
    .insert({
      business_id: businessId,
      ...parsed.data,
      description: parsed.data.description ?? null,
      created_by: user?.id ?? null,
    })
    .select("*")
    .single()

  if (error) return { ok: false, error: describeWriteError(error.message) }

  return { ok: true, rule: data }
}

/** Creates a rule from one of the starter templates. */
export async function createRuleFromTemplate(
  businessId: string,
  templateId: string,
  /** For a marketplace (ledger) starter rule: the currency to watch. */
  currency?: string
): Promise<RuleResult> {
  const template = getRuleTemplate(templateId)

  if (!template) {
    return { ok: false, error: "That starter rule does not exist." }
  }

  if (template.ledger) {
    if (!currency) return { ok: false, error: "Choose which currency to watch." }
    return createRule(businessId, {
      ...template.rule,
      name: `${template.rule.name} (${currency})`,
      ledger_currency: currency,
    })
  }

  return createRule(businessId, template.rule)
}

export async function updateRule(
  ruleId: string,
  input: UpdateRuleInput
): Promise<RuleResult> {
  const parsed = updateRuleSchema.safeParse(input)

  if (!parsed.success) {
    return {
      ok: false,
      error: "That change could not be saved.",
      fieldErrors: fieldErrorsOf(parsed.error),
    }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("automation_rules")
    .update({ ...parsed.data, description: parsed.data.description ?? null })
    .eq("id", ruleId)
    .select("*")
    .single()

  if (error) return { ok: false, error: describeWriteError(error.message) }

  return { ok: true, rule: data }
}

/**
 * Switches a rule on or off.
 *
 * Kept separate from `updateRule` because it is the common action and should
 * not require sending back every other field -- a partial update that
 * accidentally reset a threshold would be a quiet, expensive bug.
 */
export async function setRuleEnabled(
  ruleId: string,
  enabled: boolean
): Promise<RuleResult> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("automation_rules")
    .update({ enabled })
    .eq("id", ruleId)
    .select("*")
    .single()

  if (error) return { ok: false, error: describeWriteError(error.message) }

  return { ok: true, rule: data }
}

export async function deleteRule(
  ruleId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()

  const { error } = await supabase
    .from("automation_rules")
    .delete()
    .eq("id", ruleId)

  if (error) return { ok: false, error: describeWriteError(error.message) }

  return { ok: true }
}

/**
 * Runs one rule now and returns what happened.
 *
 * This is the "test this rule" path. It goes through the database function, so
 * a manual run and a scheduled run are the same code -- a preview that used a
 * different comparison could tell an owner their rule works when it does not.
 *
 * A manual run is recorded in `automation_runs` like any other, and it can
 * raise a real alert. That is deliberate: a test that could not fire would not
 * be testing the thing it claims to.
 */
export async function evaluateRuleNow(
  ruleId: string
): Promise<{ ok: true; run: AutomationRun } | { ok: false; error: string }> {
  const supabase = await createClient()

  const { data, error } = await supabase.rpc("automation_evaluate_rule", {
    p_rule_id: ruleId,
  })

  if (error) {
    console.error("[automation] evaluateRuleNow failed", error.message)
    return { ok: false, error: "That rule could not be checked just now." }
  }

  return { ok: true, run: data as AutomationRun }
}

/** Runs every enabled rule for a business. Returns how many fired. */
export async function evaluateBusinessNow(
  businessId: string
): Promise<{ ok: true; fired: number } | { ok: false; error: string }> {
  const supabase = await createClient()

  const { data, error } = await supabase.rpc("automation_evaluate_business", {
    p_business_id: businessId,
  })

  if (error) {
    console.error("[automation] evaluateBusinessNow failed", error.message)
    return { ok: false, error: "Your rules could not be checked just now." }
  }

  return { ok: true, fired: data ?? 0 }
}

/** The recent history for one rule, including the checks that stayed quiet. */
export async function listRuleRuns(
  ruleId: string,
  limit = 20
): Promise<AutomationRun[]> {
  const supabase = await createClient()

  const { data } = await supabase
    .from("automation_runs")
    .select("*")
    .eq("rule_id", ruleId)
    .order("evaluated_at", { ascending: false })
    .limit(limit)

  return data ?? []
}

/* -------------------------------------------------------------------------- */

function fieldErrorsOf(error: {
  issues: { path: PropertyKey[]; message: string }[]
}): Record<string, string[]> {
  const fields: Record<string, string[]> = {}

  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form")
    fields[key] = [...(fields[key] ?? []), issue.message]
  }

  return fields
}

/**
 * Turns a database error into something a business owner can act on.
 *
 * PostgreSQL's own wording names constraints and columns. CLAUDE.md forbids
 * showing that to a user, and it would not help them anyway -- the two errors
 * they can actually cause are a duplicate name and not having permission.
 */
function describeWriteError(message: string): string {
  if (message.includes("automation_rules_business_id_name_key")) {
    return "You already have a rule with that name. Give this one a different name."
  }

  if (
    message.includes("row-level security") ||
    message.includes("permission denied")
  ) {
    return "Only an owner or admin can change automation rules."
  }

  console.error("[automation] write failed", message)
  return "That could not be saved. Please try again."
}
