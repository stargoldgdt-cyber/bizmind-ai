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
 */

export type SemanticsStatus = "UNVERIFIED" | "CONFIRMED" | "REJECTED"

export type SourceFieldDefinition = {
  /** Our normalised key. */
  key: string
  /** The source's own column name, reproduced exactly, odd casing included. */
  sourceLabel: string
  status: SemanticsStatus
  /**
   * The BizMind metric this field may feed. NULL while unverified, and NULL is
   * the safe default: an unmapped field can mislead nobody.
   */
  mapsTo: string | null
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
 * The source's own "Profit/Loss" is Payment - product Wholesale Price
 * (49,648.59 - 53,510.20 = -3,861.61, and both sampled rows match). It is
 * preserved under that name and is NOT mapped to BizMind's net profit, because
 * the two are only equivalent if the wholesale field means one specific thing,
 * and that has not been established.
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
      status: "UNVERIFIED",
      mapsTo: null,
      note: "Gross product sales before refunds. Component of Total Sales.",
      resolutionHint:
        "Confirm against Amazon's own settlement documentation for this marketplace.",
    },
    {
      key: "shipping_fee_refund",
      sourceLabel: "Shipping Fee Refund",
      status: "UNVERIFIED",
      mapsTo: null,
      note: "Shipping charges returned to the seller.",
    },
    {
      key: "inventory_reimbursements",
      sourceLabel: "Inventory Reimbursements",
      status: "UNVERIFIED",
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
      status: "UNVERIFIED",
      mapsTo: null,
      note: "Refunds not covered by the other refund categories.",
    },
    {
      key: "refunded_expenses",
      sourceLabel: "Refunded expenses",
      status: "UNVERIFIED",
      mapsTo: null,
      note: "Expenses returned to the seller.",
    },
    {
      key: "refunded_sales",
      sourceLabel: "Refunded sales",
      status: "UNVERIFIED",
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
      status: "UNVERIFIED",
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
      status: "UNVERIFIED",
      mapsTo: null,
      note: "Shipping charged or incurred. Sign convention not established.",
    },
    {
      key: "other",
      sourceLabel: "Other",
      status: "UNVERIFIED",
      mapsTo: null,
      note: "Uncategorised amount. Blank in the sample; preserved as unknown.",
    },
    {
      key: "promo_rebates",
      sourceLabel: "Promo rebates",
      status: "UNVERIFIED",
      mapsTo: null,
      note: "Promotional discounts funded by the seller.",
    },
    {
      key: "cost_of_advertising",
      sourceLabel: "Cost of Advertising",
      status: "UNVERIFIED",
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
      status: "UNVERIFIED",
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
      status: "UNVERIFIED",
      mapsTo: null,
      note: "Warehousing charges. Blank in the sample; preserved as unknown.",
    },
    {
      key: "total_expense",
      sourceLabel: "Total Expense",
      status: "UNVERIFIED",
      mapsTo: null,
      note: "The settlement's own expense total. Part of the verified identity.",
      derived: true,
    },
    {
      key: "payment",
      sourceLabel: "Payment",
      status: "UNVERIFIED",
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
      status: "UNVERIFIED",
      mapsTo: null,
      note:
        "Source-defined product wholesale cost -- COGS attribution unverified. " +
        "It sits OUTSIDE the settlement: Total Sales - Total Expense = Payment " +
        "closes exactly without it, so Amazon did not produce this column and " +
        "no Amazon documentation defines it. It could be (A) the cost of the " +
        "units sold in the period, (B) procurement spend during the period, or " +
        "(C) a seller-specific figure. Those give materially different profit, " +
        "and the column name alone cannot distinguish them.",
      resolutionHint:
        "Two checks would settle it. First, does the value track units sold " +
        "period by period, or does it move with purchase orders? A period with " +
        "sales but no purchasing, or purchasing with no sales, separates (A) " +
        "from (B) immediately. Second, ask whoever maintains the sheet how they " +
        "populate it -- this is seller-supplied data, so the seller is the only " +
        "authority on it.",
    },
    {
      key: "profit_loss",
      sourceLabel: "Profit/Loss",
      status: "UNVERIFIED",
      mapsTo: null,
      note:
        "Source-defined result, computed as Payment - product Wholesale Price " +
        "(verified against the sample). NOT equivalent to BizMind net profit: " +
        "it inherits whatever the wholesale field means, and it excludes any " +
        "operating expense not settled through Amazon. Preserved under the " +
        "source's own name.",
      resolutionHint:
        "Cannot be confirmed before product_wholesale_price is.",
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
 * Whether a source field may feed a BizMind metric.
 *
 * The in-code definition is only half the answer: the database record in
 * `source_field_semantics` is what actually authorises a mapping, because it
 * carries who confirmed it and when. This function is the conservative check
 * used before that lookup.
 */
export function isMappable(field: SourceFieldDefinition): boolean {
  return field.status === "CONFIRMED" && field.mapsTo !== null
}
