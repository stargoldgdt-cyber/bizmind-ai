import { z } from "zod"

import {
  CANONICAL_METRICS,
  getCanonicalMetric,
  type CanonicalMetric,
} from "@/services/metrics/canonical"
import type { AutomationOperator } from "@/types/database"

/**
 * What an automation rule is allowed to say.
 *
 * WHY THE VALIDATION IS HERE AND NOT ONLY IN THE DATABASE
 * ------------------------------------------------------
 * The database has the final word -- a foreign key to `canonical_metrics`, a
 * check constraint on every range. This layer exists so a person gets a
 * sentence they can act on instead of a constraint violation, and so the UI
 * can refuse to offer a rule that could never fire.
 *
 * NO ARITHMETIC HAPPENS IN THIS FILE, OR ANYWHERE IN THIS SERVICE.
 * The threshold is carried as an exact decimal STRING from the moment it is
 * typed to the moment PostgreSQL compares it. `npm run test:money-guard`
 * fails the build if that ever stops being true.
 */

/* -------------------------------------------------------------------------- */
/* Operators                                                                   */
/* -------------------------------------------------------------------------- */

export const AUTOMATION_OPERATORS = [
  "LT",
  "LTE",
  "GT",
  "GTE",
  "CHANGE_PCT_LT",
  "CHANGE_PCT_GT",
] as const

/**
 * How each operator reads in the owner's language.
 *
 * The change operators are worded as a direction rather than a comparison,
 * because "percent change is less than -20" is a sentence nobody thinks in.
 * The sign convention is real, though, and the UI has to make it obvious:
 * a fall of 20% is a threshold of -20.
 */
export const OPERATOR_LABELS: Record<AutomationOperator, string> = {
  LT: "falls below",
  LTE: "is at or below",
  GT: "rises above",
  GTE: "is at or above",
  CHANGE_PCT_LT: "changes by less than (percent, vs the period before)",
  CHANGE_PCT_GT: "changes by more than (percent, vs the period before)",
}

export function isChangeOperator(operator: AutomationOperator): boolean {
  return operator === "CHANGE_PCT_LT" || operator === "CHANGE_PCT_GT"
}

/**
 * The metrics `analytics_compare()` produces a period-on-period change for.
 *
 * Kept as ANALYTICS keys, because that is what the SQL function labels its
 * rows with. Mirrors the list inside `automation_evaluate_rule()`; the live
 * test asserts the two agree, so a divergence is a failing test rather than a
 * rule that saves happily and then never fires.
 */
export const COMPARABLE_ANALYTICS_KEYS = [
  "revenue",
  "cogs",
  "fees",
  "gross_profit",
  "gross_margin",
  "expenses",
  "net_profit",
  "net_margin",
  "orders_count",
  "units_sold",
  "avg_order_value",
  "customers_count",
  "refunds",
  "cost_coverage",
] as const

/* -------------------------------------------------------------------------- */
/* Which metrics a rule may watch                                              */
/* -------------------------------------------------------------------------- */

/**
 * Metrics a rule can actually be written against.
 *
 * A metric with no `analyticsKey` is in the vocabulary but is not published by
 * the analytics engine, so a rule on it would evaluate to nothing forever.
 * Offering it would be offering a promise the product cannot keep.
 */
export function watchableMetrics(): CanonicalMetric[] {
  return Object.values(CANONICAL_METRICS).filter((m) => m.analyticsKey || m.ledger)
}

/** Whether a rule on this metric with this operator could ever produce a verdict. */
export function canWatch(
  metricKey: string,
  operator: AutomationOperator
): { ok: true } | { ok: false; reason: string } {
  const metric = getCanonicalMetric(metricKey)

  if (!metric) {
    return { ok: false, reason: `"${metricKey}" is not a BizMind metric.` }
  }

  if (metric.ledger) {
    if (isChangeOperator(operator) && metric.kind === "count") {
      return {
        ok: false,
        reason: `${metric.label} is a count, so it is watched by its value, not by a percentage change.`,
      }
    }
    return { ok: true }
  }

  if (!metric.analyticsKey) {
    return {
      ok: false,
      reason:
        `${metric.label} is defined but not yet published by the analytics ` +
        "engine, so a rule watching it could never fire.",
    }
  }

  if (
    isChangeOperator(operator) &&
    !COMPARABLE_ANALYTICS_KEYS.includes(
      metric.analyticsKey as (typeof COMPARABLE_ANALYTICS_KEYS)[number]
    )
  ) {
    return {
      ok: false,
      reason:
        `${metric.label} has no period-on-period comparison, so it cannot be ` +
        "watched for a percentage change. Watch its value instead.",
    }
  }

  return { ok: true }
}

/* -------------------------------------------------------------------------- */
/* The threshold                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A threshold, as exact decimal text.
 *
 * Accepted as a STRING and kept as one. `z.number()` would parse it into an
 * IEEE-754 double on the way in, and a threshold of 15.15 would be stored as
 * something fractionally else -- which is how a rule ends up firing on the
 * wrong side of a boundary an owner chose deliberately.
 */
const thresholdSchema = z
  .string()
  .trim()
  .min(1, "Enter a number for the threshold.")
  .regex(
    /^-?\d{1,15}(\.\d{1,4})?$/,
    "The threshold must be a plain number, such as 15, 15.5 or -20. " +
      "No currency symbols, thousands separators, or percent signs."
  )

/* -------------------------------------------------------------------------- */
/* Rule input                                                                  */
/* -------------------------------------------------------------------------- */

const baseRuleShape = {
  name: z
    .string()
    .trim()
    .min(1, "Give the rule a name you will recognise in an alert.")
    .max(120, "Keep the name under 120 characters."),

  description: z.string().trim().max(500).nullish(),

  metric: z.string().trim().min(1, "Choose which figure to watch."),

  operator: z.enum(AUTOMATION_OPERATORS),

  threshold: thresholdSchema,

  /**
   * A single day of data is noise for most of these figures, and a year is
   * too slow to act on. The bounds are the database's own check constraint,
   * restated so the message arrives before the insert does.
   */
  period_days: z
    .number()
    .int()
    .min(1, "The period must be at least one day.")
    .max(365, "The period cannot exceed a year."),

  severity: z.enum(["INFO", "WARNING", "CRITICAL"]),

  /**
   * Zero is allowed, and it means "tell me every time you look".
   *
   * It is a legitimate choice for a genuinely critical rule, so it is not
   * forbidden -- but it is the setting that turns an alert list into noise,
   * which is why the default is a day.
   */
  cooldown_hours: z.number().int().min(0).max(8760),

  evaluate_every_minutes: z.number().int().min(5).max(10080),

  /**
   * Defaults to true, and the UI should make turning it off feel deliberate.
   *
   * With it off, a profit rule will fire on a margin computed from incomplete
   * costs -- a figure that is overstated by an unknown amount. There are
   * honest reasons to want that (an owner who knows their costs are complete
   * for one channel), so it is a choice rather than a prohibition.
   */
  suppress_when_incomplete: z.boolean(),

  /**
   * GCC Phase 9: the currency a ledger rule watches (every marketplace account
   * in it). Required for a ledger metric and refused otherwise; amounts in
   * different currencies are never compared.
   */
  ledger_currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Choose a currency.")
    .nullish(),
}

/** Shared by create and update: the checks that need more than one field. */
function refineRule<T extends z.ZodType>(schema: T) {
  return schema.superRefine((value, ctx) => {
    const rule = value as {
      metric: string
      operator: AutomationOperator
      threshold: string
      ledger_currency?: string | null
    }

    const watchable = canWatch(rule.metric, rule.operator)
    if (!watchable.ok) {
      ctx.addIssue({
        code: "custom",
        path: ["metric"],
        message: watchable.reason,
      })
    }

    // A ratio threshold above 100 is almost always somebody entering 15% as
    // 0.15's opposite -- or entering a money figure into a margin rule. Either
    // way the rule would never fire, silently, which is the failure this whole
    // product exists to avoid. Checked by DIGIT COUNT, never by arithmetic.
    const metric = getCanonicalMetric(rule.metric)
    if (metric?.ledger && !rule.ledger_currency) {
      ctx.addIssue({
        code: "custom",
        path: ["ledger_currency"],
        message: "Choose which currency's marketplace accounts to watch.",
      })
    }
    if (metric && !metric.ledger && rule.ledger_currency) {
      ctx.addIssue({
        code: "custom",
        path: ["ledger_currency"],
        message: "Only a marketplace figure is watched in a currency.",
      })
    }
    if (
      metric?.kind === "ratio" &&
      !isChangeOperator(rule.operator) &&
      /^-?\d{4,}/.test(rule.threshold)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["threshold"],
        message:
          `${metric.label} is a percentage, so a threshold in the thousands ` +
          "would never be crossed. Enter it as a percentage, such as 15 for 15%.",
      })
    }
  })
}

export const createRuleSchema = refineRule(z.object(baseRuleShape))

export const updateRuleSchema = refineRule(
  z.object({ ...baseRuleShape, enabled: z.boolean() })
)

export type CreateRuleInput = z.input<typeof createRuleSchema>
export type UpdateRuleInput = z.input<typeof updateRuleSchema>

/* -------------------------------------------------------------------------- */
/* Explaining a skipped evaluation                                             */
/* -------------------------------------------------------------------------- */

/**
 * Why a rule did not produce an alert, in the owner's language.
 *
 * This is the whole reason `automation_runs` records non-events. An owner who
 * cannot tell "nothing was wrong" from "the check never ran" learns to
 * distrust the quiet -- and an alerting system nobody trusts is worse than
 * none, because it was relied on.
 */
export const SKIP_REASON_EXPLANATIONS: Record<string, string> = {
  COOLDOWN:
    "This rule already alerted recently, so it stayed quiet to avoid " +
    "repeating itself. Shorten the cooldown to hear about it sooner.",
  METRIC_NULL:
    "There was nothing to measure in this period — no orders, or no figure " +
    "to work from. BizMind does not treat missing data as zero.",
  INCOMPLETE_DATA:
    "Some costs or fees are missing, so this profit figure is higher than " +
    "reality. BizMind will not raise an alert on a number it knows is short.",
  DISABLED: "The rule was switched off when the check ran.",
  NO_ANALYTICS_KEY:
    "This figure is not published by the analytics engine yet, so the rule " +
    "cannot be evaluated. It should not have been possible to save it.",
  NO_COMPARISON:
    "This figure has no period-on-period comparison, so it cannot be watched " +
    "for a percentage change.",
  NO_CURRENCY: "This marketplace rule has no currency, so there was nothing to watch.",
  NO_PREVIOUS_VALUE:
    "There was no figure for the period before (or it was zero), so a " +
    "percentage change could not be measured. BizMind does not guess one.",
}

/** Why a ledger figure was not final, in the owner's language. */
const LEDGER_REASON: Record<string, string> = {
  UNKNOWN_LINES: "some marketplace lines are not recognised",
  VAT_TREATMENT_UNKNOWN: "VAT on marketplace fees has no setting",
  FEE_VAT_NOT_SEPARATED: "marketplace fees still include VAT",
  ROW_ERRORS: "some marketplace rows could not be read",
  SKU_NOT_MAPPED: "some SKUs are not matched to a product",
  COST_MISSING: "some products have no cost for the sale date",
  NO_MARKETPLACE_DATA: "there are no marketplace figures",
  EXPENSES_UNCLASSIFIED: "some expense categories are not placed yet",
}

/**
 * A skip reason may carry the ledger's own reasons after a colon
 * ("INCOMPLETE_DATA:SKU_NOT_MAPPED,COST_MISSING", migration 0041).
 */
export function explainSkip(reason: string | null): string | null {
  if (!reason) return null
  const [code, detail] = reason.split(":", 2)
  if (code === "INCOMPLETE_DATA" && detail) {
    const why = detail.split(",").map((r) => LEDGER_REASON[r] ?? r).join("; ")
    return `This figure is not final (${why}), so BizMind did not judge it. It will be checked again once that is fixed.`
  }
  return SKIP_REASON_EXPLANATIONS[code] ?? "The check did not reach a verdict."
}
