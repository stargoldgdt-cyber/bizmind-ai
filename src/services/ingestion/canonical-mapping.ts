/**
 * Source column -> canonical metric: suggestions only.
 *
 * FLEXIBLE SOURCE FIELDS. STANDARD BIZMIND MEANING.
 *
 * A business should not have to rename its spreadsheet columns to use BizMind.
 * This module reads a column heading and proposes which canonical metric it
 * probably represents.
 *
 * WHAT THIS MODULE CANNOT DO
 * --------------------------
 * It cannot confirm anything. Nothing here returns CONFIRMED, and there is no
 * argument that makes it. A name produces a SUGGESTION; only a person produces
 * a meaning, recorded against their name in `source_field_semantics`.
 *
 * The reason is that column names are confident and imprecise at the same
 * time. "Wholesale Price" can be:
 *
 *   A. the cost of the units actually sold      (cost of goods)
 *   B. what was spent restocking this period    (procurement, not COGS)
 *   C. what the held inventory is worth         (a balance, not a cost)
 *   D. the price charged to trade buyers        (revenue, not cost at all)
 *
 * All four are ordinary bookkeeping. The name cannot separate them, and each
 * produces a different profit figure. A system that guesses is right often
 * enough to be trusted and wrong often enough to be dangerous, which is the
 * worst combination a financial product can have.
 *
 * So the system prefers "I need you to confirm what this means" over "I have
 * worked out what this means".
 *
 * NO ARITHMETIC HAPPENS HERE. This module compares strings. Every financial
 * calculation stays in SQL.
 */

import { isMappableMetric } from "@/services/metrics/canonical"

/**
 * The lifecycle of a mapping.
 *
 * `SUGGESTED`             -- BizMind proposes it; nobody has looked yet.
 * `PENDING_CONFIRMATION`  -- shown to a person, awaiting their decision.
 * `CONFIRMED`             -- a person stated the meaning. Only this may feed
 *                            an authoritative figure.
 * `REJECTED`              -- examined and found NOT to mean what it appeared to.
 * `UNKNOWN`               -- the person looked and genuinely does not know.
 *                            An honest answer, and a useful one: it stops the
 *                            question being asked again every import.
 */
export type MappingStatus =
  | "SUGGESTED"
  | "PENDING_CONFIRMATION"
  | "CONFIRMED"
  | "REJECTED"
  | "UNKNOWN"

/** The only statuses this module may ever produce. */
export type SuggestedStatus = Extract<MappingStatus, "SUGGESTED" | "PENDING_CONFIRMATION">

/**
 * How strongly the name points at the metric.
 *
 * Confidence is about the NAME, never about the number. A high-confidence
 * suggestion is still only a suggestion.
 */
export type MappingConfidence = "high" | "medium" | "low"

export type MappingSuggestion = {
  /** The column heading exactly as the source wrote it. */
  sourceLabel: string
  /** The canonical metric this column probably represents. */
  candidateMetric: string
  confidence: MappingConfidence
  status: SuggestedStatus
  /** Why BizMind proposed this, phrased for the owner to check. */
  reason: string
  /**
   * Set when the name is a known false friend: it matches, and it routinely
   * means something else. Drives the wording of the question asked.
   */
  ambiguityWarning?: string
}

/* -------------------------------------------------------------------------- */
/* The alias table                                                            */
/* -------------------------------------------------------------------------- */

type AliasRule = {
  metric: string
  /** Normalised names that point at this metric. */
  aliases: string[]
  /** Names that match but are known to mean something else just as often. */
  ambiguous?: Record<string, string>
}

/**
 * Known ways businesses name each concept.
 *
 * Adding an alias here widens what BizMind will ASK about. It never widens
 * what BizMind will assume.
 */
const ALIAS_RULES: AliasRule[] = [
  {
    metric: "cogs",
    aliases: [
      "cogs",
      "cost of goods",
      "cost of goods sold",
      "cost of sales",
      "product cost",
      "product wholesale price",
      "wholesale price",
      "wholesale cost",
      "cost price",
      "unit cost",
      "item cost",
      "landed cost",
      "purchase cost",
      "buy price",
      "buying price",
      "supplier cost",
    ],
    ambiguous: {
      "product cost":
        "Product cost can mean what the units sold cost you, or what you paid " +
        "suppliers this period. Those are different numbers.",
      "product wholesale price":
        "A wholesale price can be what you PAY a supplier or what you CHARGE a " +
        "trade buyer. Only the first is a cost.",
      "wholesale price":
        "A wholesale price can be what you PAY a supplier or what you CHARGE a " +
        "trade buyer. Only the first is a cost.",
      "wholesale cost":
        "This may be the cost of what sold, or the value of stock you hold. " +
        "Only the first belongs in profit.",
      "purchase cost":
        "Purchase cost usually means restocking spend for the period, which is " +
        "not the cost of what actually sold.",
      "landed cost":
        "Landed cost sometimes includes freight and duty and sometimes does " +
        "not, which changes margin.",
      "supplier cost":
        "This may be a per-unit price or a total invoiced amount.",
    },
  },
  {
    metric: "revenue",
    aliases: [
      "revenue",
      "sales",
      "total sales",
      "net sales",
      "gross sales",
      "sales revenue",
      "product sales",
      "turnover",
      "income",
    ],
    ambiguous: {
      "net sales":
        "Net sales is usually already after refunds. Mapping it to revenue AND " +
        "mapping a refunds column would subtract refunds twice.",
      "total sales":
        "A total may or may not already have refunds taken off it.",
      income:
        "Income can mean sales, or it can mean what was actually received after " +
        "deductions.",
    },
  },
  {
    metric: "marketplace_fees",
    aliases: [
      "amazon fees",
      "marketplace fees",
      "marketplace fee",
      "selling fees",
      "selling fee",
      "platform fees",
      "platform fee",
      "referral fees",
      "referral fee",
      "commission",
      "commission fee",
      "channel fees",
      "seller fees",
      "transaction fees",
      "payment processing fees",
    ],
    ambiguous: {
      "amazon fees":
        "Some exports put fulfilment and storage inside this figure and some " +
        "list them separately. Counting both would double the charge.",
      commission:
        "Commission may be what a marketplace takes, or what you pay your own " +
        "salespeople.",
    },
  },
  {
    metric: "advertising_cost",
    aliases: [
      "advertising",
      "advertising cost",
      "cost of advertising",
      "ad spend",
      "ads spend",
      "ad cost",
      "marketing cost",
      "marketing spend",
      "ppc cost",
      "ppc spend",
      "sponsored ads",
    ],
  },
  {
    metric: "shipping_expense",
    aliases: [
      "shipping cost",
      "shipping expense",
      "delivery cost",
      "freight cost",
      "freight",
      "postage",
      "courier cost",
      "fulfilment cost",
      "fulfillment cost",
    ],
    ambiguous: {
      "shipping cost":
        "This may be what the carrier charged you, or what you charged the " +
        "customer for delivery. The second one is revenue, not a cost.",
      freight:
        "Freight is sometimes part of the landed cost of goods instead of a " +
        "separate expense, which would double-count it.",
    },
  },
  {
    metric: "storage_cost",
    aliases: [
      "storage fee",
      "storage cost",
      "storage fees",
      "warehousing",
      "warehouse fee",
      "inventory storage",
      "long term storage fee",
    ],
  },
  {
    metric: "refunds",
    aliases: [
      "refunds",
      "refund",
      "refunded sales",
      "refunded amount",
      "returns",
      "returns value",
      "customer refunds",
      "chargebacks",
    ],
    ambiguous: {
      "refunded sales":
        "Check whether your sales total is already net of this. If it is, " +
        "counting refunds again would understate revenue twice over.",
      returns:
        "Returns can be a count of returned orders or the money refunded.",
    },
  },
  {
    metric: "promotional_rebates",
    aliases: [
      "promo rebates",
      "promotional rebates",
      "promotions",
      "promotion cost",
      "discounts funded",
      "coupon cost",
      "voucher cost",
      "seller funded discounts",
    ],
  },
  {
    metric: "other_expenses",
    aliases: [
      "other expenses",
      "other charges",
      "miscellaneous",
      "misc expenses",
      "sundry expenses",
      "adjustments",
    ],
    ambiguous: {
      adjustments:
        "An adjustment can be a charge or a credit, and the sign convention " +
        "differs between sources.",
      other:
        "An uncategorised column tells you nothing about its direction or its " +
        "contents.",
    },
  },
  {
    metric: "operating_expenses",
    aliases: [
      "operating expenses",
      "opex",
      "overheads",
      "running costs",
      "business expenses",
    ],
  },
  {
    metric: "total_expense",
    aliases: [
      "total expense",
      "total expenses",
      "total charges",
      "total deductions",
      "total costs",
      "total fees",
    ],
    ambiguous: {
      "total expense":
        "A source's total only covers what that source knows about. It is " +
        "never all of the business's costs.",
      "total costs":
        "Check whether cost of goods is inside this total or outside it.",
    },
  },
  {
    metric: "payment_received",
    aliases: [
      "payment",
      "payout",
      "payments",
      "settlement amount",
      "net payout",
      "amount received",
      "disbursement",
      "transfer amount",
    ],
    ambiguous: {
      payment:
        "A payout is what reached your bank, which is not the same as what you " +
        "earned in the period.",
    },
  },
  {
    metric: "orders",
    aliases: ["orders", "order count", "number of orders", "total orders", "transactions"],
  },
  {
    metric: "units",
    aliases: ["units", "units sold", "quantity sold", "total quantity", "qty sold", "items sold"],
  },
]

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

/** Lowercase, strip punctuation, collapse whitespace. */
export function normaliseLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[_\-./\\]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Names so short or so generic that a substring match on them is noise.
 * "Other" matching "other expenses" is fine; "other" matching "Brother" is not.
 */
const MIN_PARTIAL_LENGTH = 6

/**
 * Proposes a canonical metric for a source column.
 *
 * Returns `null` when nothing plausible matches — which is the honest answer,
 * and better than a low-confidence guess that a hurried person might accept.
 *
 * The status is never CONFIRMED. See the header of this file.
 */
export function suggestMetricForColumn(sourceLabel: string): MappingSuggestion | null {
  const key = normaliseLabel(sourceLabel)
  if (key === "") return null

  for (const rule of ALIAS_RULES) {
    if (rule.aliases.includes(key)) {
      const warning = rule.ambiguous?.[key]
      return {
        sourceLabel,
        candidateMetric: rule.metric,
        // An exact hit on a known false friend is not high confidence, however
        // exact the string match was. The name is precisely the problem.
        confidence: warning ? "medium" : "high",
        status: "PENDING_CONFIRMATION",
        reason: warning
          ? `"${sourceLabel}" is a common name for this figure, but not only for this figure.`
          : `"${sourceLabel}" is a standard name for this figure.`,
        ambiguityWarning: warning,
      }
    }
  }

  // Looser matching, for headings that carry extra words: "FBA Storage Fee
  // (AED)". Deliberately second, so a precise heading never loses to a vague
  // one, and deliberately low confidence.
  for (const rule of ALIAS_RULES) {
    const hit = rule.aliases.find(
      (alias) => alias.length >= MIN_PARTIAL_LENGTH && key.includes(alias)
    )
    if (hit) {
      return {
        sourceLabel,
        candidateMetric: rule.metric,
        confidence: "low",
        status: "PENDING_CONFIRMATION",
        reason: `"${sourceLabel}" contains "${hit}", which usually means this figure.`,
        ambiguityWarning:
          rule.ambiguous?.[hit] ??
          "The heading has extra words, so this match is a guess about the part that matched.",
      }
    }
  }

  return null
}

/** Suggestions for a whole file, in the order the columns appeared. */
export function suggestMetricsForColumns(columns: string[]): MappingSuggestion[] {
  const out: MappingSuggestion[] = []
  for (const column of columns) {
    const suggestion = suggestMetricForColumn(column)
    if (suggestion) out.push(suggestion)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether a metric may legally be the target of a confirmed mapping.
 *
 * Refuses unknown keys and refuses every computed metric. A source column can
 * never BE gross profit or net profit: those are conclusions BizMind reaches,
 * and a source figure wearing that name would inherit trust it has not earned.
 *
 * The database enforces the same rule. This is the early, friendlier refusal.
 */
export function canConfirmMappingTo(metricKey: string): boolean {
  return isMappableMetric(metricKey)
}

/**
 * The set of columns in a file, in a stable form.
 *
 * Two imports of the same export produce the same signature regardless of
 * column order or spacing, which is what lets a confirmed mapping be reused
 * without asking the same question again. A file with a NEW column produces a
 * different signature, so the new column gets asked about — which is the
 * behaviour that matters.
 */
export function columnSignature(columns: string[]): string {
  return [...new Set(columns.map(normaliseLabel))]
    .filter((c) => c !== "")
    .sort()
    .join("|")
}
