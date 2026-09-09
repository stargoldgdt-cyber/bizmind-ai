/**
 * Source field semantics.
 *
 * A column in someone else's report is not a BizMind metric. It becomes one
 * only when a person confirms what it means, and that confirmation is recorded
 * against their name in `source_field_semantics`.
 *
 * This file holds what is KNOWN about the fields we have seen, including the
 * ones we deliberately do not understand yet. Its purpose is to make the
 * unknowns visible rather than let them be quietly resolved by whoever writes
 * the next mapping.
 *
 * THE RULE
 * --------
 * `mapsTo: null` means the field is preserved and displayed under the source's
 * own name, and never feeds a BizMind figure. Only an explicit confirmation,
 * stored in the database, can change that — not an edit to this file.
 *
 * A `CONFIRMED` entry here is DOCUMENTATION of a decision somebody made, not
 * the decision itself. Analytics reads `source_field_semantics`, where the
 * confirmation carries a real user id and a timestamp and is held in place by
 * database constraints. Editing this file grants nothing; it only records what
 * was already granted, so the reasoning survives in the repository.
 *
 * Mapping targets come from the canonical vocabulary in
 * `src/services/metrics/canonical.ts`. A field can only ever be mapped to a
 * SOURCED metric — never to gross profit, net profit or a margin, which
 * BizMind calculates for itself.
 */

import type { MappingStatus } from "./canonical-mapping"

export type SemanticsStatus = MappingStatus

export type SourceFieldDefinition = {
  /** Our normalised key. */
  key: string
  /** The source's own column name, reproduced exactly, odd casing included. */
  sourceLabel: string
  status: SemanticsStatus
  /**
   * What BizMind SUSPECTS the field means. A name-matching result. It exists
   * so the question can be asked well; it authorises nothing.
   */
  candidateMetric?: string | null
  /**
   * The canonical metric this field may feed. NULL until a person confirms it,
   * and NULL is the safe default: an unmapped field can mislead nobody.
   */
  mapsTo: string | null
  /** Who established the meaning. Present only on a CONFIRMED field. */
  confirmedBy?: string
  /** What is known and, more importantly, what is not. */
  note: string
  /** What evidence would settle the question. */
  resolutionHint?: string
  /** True when the source computes this from its own other columns. */
  derived?: boolean
}

export type SourceProfile = {
  key: string
  label: string
  /** Which system produced the report. */
  source: string
  description: string
  fields: SourceFieldDefinition[]
  /** Identities the report should satisfy, checked at import and recorded. */
  reconciliations: {
    name: string
    description: string
    /** Human-readable formula. Evaluated in SQL, never in JavaScript. */
    formula: string
  }[]
}

/**
 * Amazon.ae seller settlement report.
 *
 * Established from the supplied 7-record sample:
 *
 *   Total Sales - Total Expense = Payment   reconciles EXACTLY
 *   (74,644.49 - 24,995.90 = 49,648.59)
 *
 * That identity matters more than it first appears. Because it closes exactly,
 * "product Wholesale Price" is NOT part of the settlement — Amazon did not
 * produce that column. It is seller-supplied data appended to the export,
 * which means no Amazon documentation can define it. Only the seller can.
 *
 * That question has since been answered. The business owner confirmed that for
 * THIS business the column holds the cost of the units sold, so it is mapped to
 * `cogs` with their confirmation on record. The confirmation is about this
 * seller's bookkeeping, not about the phrase: another business's "Wholesale
 * Price" column starts again as an open question.
 *
 * The source's own "Profit/Loss" is Payment - product Wholesale Price
 * (49,648.59 - 53,510.20 = -3,861.61, and both sampled rows match). It stays
 * under that name and is NOT BizMind's net profit — now for a structural
 * reason as well as a semantic one: net profit is a COMPUTED metric, and no
 * source column may be mapped to one. It also omits every operating expense
 * Amazon never saw.
 */
export const AMAZON_SETTLEMENT: SourceProfile = {
  key: "amazon_ae_settlement",
  label: "Amazon.ae settlement report",
  source: "AMAZON",
  description:
    "Period settlement export. Sales, refunds and Amazon's own charges, plus " +
    "seller-supplied cost data appended by the seller.",

  fields: [
    /* ---- Amazon's own figures. Their meaning is defined by Amazon. ------- */
    {
      key: "sales",
      sourceLabel: "Sales",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "revenue",
      mapsTo: null,
      note: "Gross product sales before refunds. Component of Total Sales.",
      resolutionHint:
        "Confirm against Amazon's own settlement documentation for this marketplace.",
    },
    {
      key: "shipping_fee_refund",
      sourceLabel: "Shipping Fee Refund",
      status: "PENDING_CONFIRMATION",
      mapsTo: null,
      note: "Shipping charges returned to the seller.",
    },
    {
      key: "inventory_reimbursements",
      sourceLabel: "Inventory Reimbursements",
      status: "PENDING_CONFIRMATION",
      mapsTo: null,
      note:
        "Compensation for lost or damaged inventory. BLANK throughout the " +
        "sample; blank is preserved as unknown, not treated as zero.",
      resolutionHint:
        "Blank may mean 'no reimbursements in this period' or 'not reported in " +
        "this export'. Amazon's documentation, or a period where the value is " +
        "non-zero, would settle it.",
    },
    {
      key: "other_refund",
      sourceLabel: "Other Refund",
      status: "PENDING_CONFIRMATION",
      mapsTo: null,
      note: "Refunds not covered by the other refund categories.",
    },
    {
      key: "refunded_expenses",
      sourceLabel: "Refunded expenses",
      status: "PENDING_CONFIRMATION",
      mapsTo: null,
      note: "Expenses returned to the seller.",
    },
    {
      key: "refunded_sales",
      sourceLabel: "Refunded sales",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "refunds",
      mapsTo: null,
      note:
        "Sales value refunded to buyers. A candidate for BizMind's refunds " +
        "metric, but not mapped until its sign convention and its relationship " +
        "to Total Sales are confirmed.",
      resolutionHint:
        "Determine whether Total Sales is already net of this, or gross of it. " +
        "Mapping it while that is unknown would double-count refunds.",
    },
    {
      key: "total_sales",
      sourceLabel: "Total Sales",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "revenue",
      mapsTo: null,
      note:
        "The settlement's own sales total. Reconciles exactly as " +
        "Total Sales - Total Expense = Payment across the sample.",
      resolutionHint:
        "Confirm whether it is gross or net of refunds before mapping to revenue.",
      derived: true,
    },
    {
      key: "shipping_fee",
      sourceLabel: "Shipping Fee",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "shipping_expense",
      mapsTo: null,
      note: "Shipping charged or incurred. Sign convention not established.",
    },
    {
      key: "other",
      sourceLabel: "Other",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "other_expenses",
      mapsTo: null,
      note: "Uncategorised amount. Blank in the sample; preserved as unknown.",
    },
    {
      key: "promo_rebates",
      sourceLabel: "Promo rebates",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "promotional_rebates",
      mapsTo: null,
      note: "Promotional discounts funded by the seller.",
    },
    {
      key: "cost_of_advertising",
      sourceLabel: "Cost of Advertising",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "advertising_cost",
      mapsTo: null,
      note:
        "BLANK across every row of the sample. Preserved as unknown. Treating " +
        "it as zero would state that no advertising was bought, which the file " +
        "does not say.",
      resolutionHint:
        "Advertising is often settled in a separate Amazon report. Confirm " +
        "whether this export ever populates the column before assuming blank " +
        "means zero spend.",
    },
    {
      key: "amazon_fees",
      sourceLabel: "Amazon fees",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "marketplace_fees",
      mapsTo: null,
      note:
        "Marketplace commission and related charges. The strongest candidate " +
        "for BizMind's channel fees, pending confirmation of what it includes.",
      resolutionHint:
        "Establish whether it includes fulfilment and storage, or only referral " +
        "fees, so fees are not counted twice against Storage Fee.",
    },
    {
      key: "storage_fee",
      sourceLabel: "Storage Fee",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "storage_cost",
      mapsTo: null,
      note: "Warehousing charges. Blank in the sample; preserved as unknown.",
    },
    {
      key: "total_expense",
      sourceLabel: "Total Expense",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "total_expense",
      mapsTo: null,
      note: "The settlement's own expense total. Part of the verified identity.",
      derived: true,
    },
    {
      key: "payment",
      sourceLabel: "Payment",
      status: "PENDING_CONFIRMATION",
      candidateMetric: "payment_received",
      mapsTo: null,
      note:
        "What Amazon actually paid out. Equals Total Sales - Total Expense " +
        "exactly across the sample.",
      derived: true,
    },

    /* ---- Seller-supplied. Amazon did not produce these. ------------------ */
    {
      key: "product_wholesale_price",
      sourceLabel: "product Wholesale Price",
      status: "CONFIRMED",
      candidateMetric: "cogs",
      mapsTo: "cogs",
      confirmedBy: "Business owner",
      note:
        "CONFIRMED BY THE BUSINESS OWNER as this seller's cost of goods." +
        "\n\n" +
        "The question was open until they answered it, and it could not have " +
        "been settled from the file. The column sits OUTSIDE the settlement: " +
        "Total Sales - Total Expense = Payment closes exactly without it, so " +
        "Amazon never produced it. It is seller-supplied, which means no " +
        "Amazon documentation could ever define it. The three readings the " +
        "name allowed were (A) the cost of the units sold in the period, " +
        "(B) procurement spend during the period, and (C) a seller-specific " +
        "figure. They give materially different profit. The owner confirmed " +
        "(A)." +
        "\n\n" +
        "THIS CONFIRMATION IS ABOUT THIS BUSINESS, NOT ABOUT THE NAME. Another " +
        "seller's 'Wholesale Price' column is still unknown and is asked about " +
        "from scratch. Nothing here makes the phrase mean cost of goods.",
      resolutionHint:
        "Settled. If the way the sheet is filled in ever changes, the mapping " +
        "must be re-confirmed rather than assumed to still hold.",
    },
    {
      key: "profit_loss",
      sourceLabel: "Profit/Loss",
      status: "PENDING_CONFIRMATION",
      mapsTo: null,
      note:
        "Source-defined result, computed as Payment - product Wholesale Price " +
        "(verified against the sample). NOT BizMind net profit, and it cannot " +
        "become it: net_profit is a COMPUTED metric, so no source column may " +
        "be mapped to it at all. The database refuses it, not just this file." +
        "\n\n" +
        "Even now that the wholesale column is confirmed as cost of goods, this " +
        "figure still excludes every operating expense that was never settled " +
        "through Amazon. Preserved under the source's own name so it can be " +
        "compared against BizMind's own figure rather than mistaken for it.",
      resolutionHint:
        "There is nothing to confirm. A source cannot supply a conclusion " +
        "BizMind reaches for itself. To make BizMind's net profit match this " +
        "figure, record the missing expenses.",
      derived: true,
    },
  ],

  reconciliations: [
    {
      name: "sales_minus_expense_equals_payment",
      description:
        "Amazon's settlement identity. Verified across the supplied sample " +
        "(74,644.49 - 24,995.90 = 49,648.59). A row that fails this is " +
        "RECORDED, never corrected.",
      formula: "total_sales - total_expense = payment",
    },
    {
      name: "source_profit_equals_payment_minus_wholesale",
      description:
        "Confirms how the source computes its own Profit/Loss. Verified on " +
        "both sampled rows and on the totals. Establishes the source's formula; " +
        "it does not establish what the wholesale figure means.",
      formula: "payment - product_wholesale_price = profit_loss",
    },
  ],
}

export const SOURCE_PROFILES: Record<string, SourceProfile> = {
  [AMAZON_SETTLEMENT.key]: AMAZON_SETTLEMENT,
}

/**
 * The fields a profile will not let into a BizMind figure.
 *
 * Used to show the owner exactly what is being preserved but not used, so the
 * gap is visible rather than something they discover when a number looks wrong.
 */
export function unverifiedFields(profile: SourceProfile): SourceFieldDefinition[] {
  return profile.fields.filter((f) => f.status !== "CONFIRMED" || f.mapsTo === null)
}

/**
 * Whether this file RECORDS a confirmed mapping for the field.
 *
 * It does not grant one. Authorisation lives in `source_field_semantics`,
 * where a confirmation carries a user id and a timestamp and is held in place
 * by database constraints. This is documentation of a decision, checked here
 * so the repository and the database can be compared and any disagreement
 * found by a test rather than by a wrong number.
 */
export function hasDocumentedConfirmation(field: SourceFieldDefinition): boolean {
  return field.status === "CONFIRMED" && field.mapsTo !== null
}

/** Every field in a profile whose meaning a person has settled. */
export function confirmedFields(profile: SourceProfile): SourceFieldDefinition[] {
  return profile.fields.filter(hasDocumentedConfirmation)
}

/**
 * Fields BizMind has a guess about and no answer to.
 *
 * This is the list the import wizard turns into questions.
 */
export function fieldsAwaitingConfirmation(
  profile: SourceProfile
): SourceFieldDefinition[] {
  return profile.fields.filter(
    (f) => f.status === "SUGGESTED" || f.status === "PENDING_CONFIRMATION"
  )
}
