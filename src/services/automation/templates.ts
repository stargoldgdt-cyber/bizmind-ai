import type { CreateRuleInput } from "./contracts"

/**
 * Starter rules.
 *
 * WHY THESE EXIST
 * ---------------
 * An owner asked to invent thresholds from a blank page will either skip the
 * feature or pick numbers at random. These are a sensible opening position
 * they can adjust once they have seen one fire.
 *
 * WHY THEY ARE NOT ENABLED AUTOMATICALLY
 * -------------------------------------
 * Every threshold here is a GUESS. A 15% gross margin is comfortable for one
 * business and a crisis for another, and BizMind has no customer data to
 * calibrate against -- the same honesty the health score bands are written
 * with. Silently switching on rules built from guesses would produce alerts
 * that feel authoritative and are arbitrary.
 *
 * So an owner picks them, sees the number BizMind chose, and changes it.
 *
 * WHAT IS DELIBERATELY MISSING
 * ----------------------------
 * Inventory days-of-cover and receivables ageing were both in the Phase 11
 * design and are not here. Days-of-cover needs a sales rate per SKU that the
 * universal model does not yet carry, and receivables ageing needs invoices,
 * which BizMind does not model at all. A rule that cannot be computed from
 * verified figures does not get a plausible substitute.
 */

export type RuleTemplate = {
  id: string
  /** What the owner is actually worried about, in their words. */
  concern: string
  /** Why this threshold, stated plainly so it can be argued with. */
  rationale: string
  rule: CreateRuleInput
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "margin_floor",
    concern: "I am selling more but keeping less of it.",
    rationale:
      "15% gross margin is a common floor for small multi-channel retail — " +
      "below it, fees and returns can wipe out a month. Your own floor " +
      "depends on your overheads, so change this to the number that would " +
      "actually worry you.",
    rule: {
      name: "Gross margin below 15%",
      description:
        "Watches gross margin over the last 30 days and alerts if it drops " +
        "below 15%.",
      metric: "gross_margin",
      operator: "LT",
      threshold: "15",
      period_days: 30,
      severity: "WARNING",
      cooldown_hours: 24,
      evaluate_every_minutes: 360,
      suppress_when_incomplete: true,
    },
  },

  {
    id: "revenue_drop",
    concern: "Sales are falling and I want to know before the month ends.",
    rationale:
      "Compares the last 14 days with the 14 before. Fourteen days is long " +
      "enough that a slow weekend does not trigger it, and short enough to " +
      "still be worth acting on. A 20% fall is well outside normal weekly " +
      "variation for most sellers.",
    rule: {
      name: "Revenue down more than 20%",
      description:
        "Compares the last 14 days with the 14 days before, and alerts if " +
        "revenue has fallen by more than 20%.",
      metric: "revenue",
      // A FALL of more than 20% is a percentage change below -20.
      operator: "CHANGE_PCT_LT",
      threshold: "-20",
      period_days: 14,
      severity: "CRITICAL",
      cooldown_hours: 48,
      evaluate_every_minutes: 360,
      suppress_when_incomplete: true,
    },
  },

  {
    id: "expense_spike",
    concern: "My costs are creeping up without me noticing.",
    rationale:
      "Operating expenses rising 25% month on month is usually either a real " +
      "problem or a one-off purchase worth remembering. Either way it should " +
      "be a decision rather than a surprise.",
    rule: {
      name: "Expenses up more than 25%",
      description:
        "Compares the last 30 days with the 30 before, and alerts if " +
        "operating expenses have risen by more than 25%.",
      metric: "operating_expenses",
      operator: "CHANGE_PCT_GT",
      threshold: "25",
      period_days: 30,
      severity: "WARNING",
      cooldown_hours: 72,
      evaluate_every_minutes: 720,
      suppress_when_incomplete: true,
    },
  },

  {
    id: "refunds_rising",
    concern: "Am I getting more returns than usual?",
    /**
     * Watches the CHANGE in refunds, not a share of revenue.
     *
     * `refund_rate` exists in the analytics engine but is not in the canonical
     * vocabulary, so no rule can target it yet -- and a rule watching the
     * refund AMOUNT against a fixed number would mean something different for
     * every business, and something different for the same business after a
     * good month. A month-on-month rise is comparable on its own terms.
     */
    rationale:
      "Compares refunds over the last 30 days with the 30 before. A 40% rise " +
      "usually points at one product or one listing rather than a general " +
      "trend, which makes it worth looking at while it is still small.",
    rule: {
      name: "Refunds up more than 40%",
      description:
        "Compares refunds over the last 30 days with the 30 days before.",
      metric: "refunds",
      operator: "CHANGE_PCT_GT",
      threshold: "40",
      period_days: 30,
      severity: "WARNING",
      cooldown_hours: 72,
      evaluate_every_minutes: 720,
      // Refunds are recorded directly. Missing costs do not distort them.
      suppress_when_incomplete: false,
    },
  },

  {
    id: "cost_coverage",
    concern: "How much of what BizMind tells me can I actually rely on?",
    rationale:
      "Cost coverage is the share of sold items that have a cost recorded. " +
      "Below 80%, every profit and margin figure on your dashboard is " +
      "overstated by an unknown amount — and this alert is the one that tells " +
      "you why the others have gone quiet.",
    rule: {
      name: "Cost coverage below 80%",
      description:
        "Alerts when fewer than 80% of sold items have a cost recorded, " +
        "which makes profit figures unreliable.",
      metric: "cost_coverage",
      operator: "LT",
      threshold: "80",
      period_days: 30,
      severity: "INFO",
      cooldown_hours: 168,
      evaluate_every_minutes: 1440,
      // This rule EXISTS to report incomplete data. Suppressing it when data
      // is incomplete would silence the one alert that explains the silence.
      suppress_when_incomplete: false,
    },
  },
]

export function getRuleTemplate(id: string): RuleTemplate | undefined {
  return RULE_TEMPLATES.find((t) => t.id === id)
}
