import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import type { Database } from "@/types/database"

/**
 * Findings and open items for the home dashboard.
 *
 * Deterministic: each one is a sentence built from a figure or share the
 * database already produced (dashboard_overview). Nothing is calculated here,
 * no threshold is invented beyond the plain ones stated in each rule, and no
 * model is involved.
 */

type Overview = Database["public"]["Functions"]["dashboard_overview"]["Returns"][number]

export type Tone = "attention" | "watch" | "info" | "good"

export type Finding = {
  id: string
  tone: Tone
  title: string
  body: string
  href: string
  action: string
}

const REASON: Record<string, string> = {
  UNKNOWN_LINES: "some marketplace lines are not recognised",
  VAT_TREATMENT_UNKNOWN: "VAT on marketplace fees has no setting",
  FEE_VAT_NOT_SEPARATED: "some marketplace fees still include VAT",
  ROW_ERRORS: "some uploaded rows could not be read",
  SKU_NOT_MAPPED: "some SKUs are not matched to a product",
  COST_MISSING: "some products have no cost for the sale date",
  NO_MARKETPLACE_DATA: "there are no marketplace figures this month",
  EXPENSES_UNCLASSIFIED: "some expense categories are not placed",
  EXPENSES_BUSINESS_WIDE: "expenses belong to all accounts in the currency",
}

export function reasonText(reasons: readonly string[]): string {
  return reasons.map((r) => REASON[r] ?? r).join("; ")
}

/** What stops a figure being final, each with the one place to fix it. */
export function openItems(o: Overview, monthKey: string): Finding[] {
  const items: Finding[] = []
  const reasons = new Set([...o.contribution_reasons, ...o.gross_profit_reasons, ...o.net_profit_reasons])
  const n = (value: number | null | undefined) => formatNumber(value ?? 0)

  if (reasons.has("UNKNOWN_LINES") || (o.unknown_lines ?? 0) > 0) {
    items.push({
      id: "unknown",
      tone: "attention",
      title: `${n(o.unknown_lines)} marketplace lines not recognised`,
      body: "Every figure stays incomplete until they are classified.",
      href: "/ledger/quality",
      action: "Classify them",
    })
  }
  if (reasons.has("VAT_TREATMENT_UNKNOWN")) {
    items.push({
      id: "vat",
      tone: "attention",
      title: "VAT on marketplace fees has no setting",
      body: "Ask your accountant whether it is recoverable, then set it per account.",
      href: "/marketplaces",
      action: "Set VAT on fees",
    })
  }
  if (reasons.has("FEE_VAT_NOT_SEPARATED")) {
    items.push({
      id: "fee-vat",
      tone: "attention",
      title: "Some marketplace fees still include VAT",
      body: "noon: upload the month's Invoices and Credit Notes. Amazon's Paid Services Fee arrives with VAT inside it and no file separates it yet, so it stays not final while VAT on fees is Recoverable.",
      href: "/ledger/quality",
      action: "See which fees",
    })
  }
  if (o.unmatched_skus > 0) {
    items.push({
      id: "skus",
      tone: "attention",
      title: `${n(o.unmatched_skus)} SKU${o.unmatched_skus === 1 ? "" : "s"} sold this month need${o.unmatched_skus === 1 ? "s" : ""} product mapping`,
      body: `${formatNumber(o.units_without_product, 4)} units sold this month have no product, so gross profit is not final.`,
      href: "/catalog#needs-attention",
      action: "Set them up",
    })
  }
  if (reasons.has("COST_MISSING")) {
    items.push({
      id: "costs",
      tone: "attention",
      title: "Products without a cost",
      body: `${formatNumber(o.units_without_cost, 4)} units sold this month have no cost for their sale date.`,
      href: "/catalog",
      action: "Add costs",
    })
  }
  if (o.unplaced_expense_categories > 0) {
    items.push({
      id: "expenses",
      tone: "attention",
      title: `${n(o.unplaced_expense_categories)} expense categories to place`,
      body: "Net profit stays incomplete until each is placed once.",
      href: `/ledger/expenses?month=${monthKey}`,
      action: "Place them",
    })
  }
  if (o.payouts_in_doubt > 0) {
    items.push({
      id: "mismatch",
      tone: "attention",
      title: `${n(o.payouts_in_doubt)} settlements do not add up`,
      body: "Their expected payouts are in doubt. Check them against the marketplace's own report.",
      href: `/ledger/payouts?month=${monthKey}`,
      action: "Review payouts",
    })
  }
  if (o.open_quality_items > 0 && !items.some((i) => i.id === "unknown")) {
    items.push({
      id: "quality",
      tone: "watch",
      title: `${n(o.open_quality_items)} data quality item${o.open_quality_items === 1 ? "" : "s"} open`,
      body: "Things BizMind could not read or match cleanly this month.",
      href: "/ledger/quality",
      action: "Open data quality",
    })
  }
  if ((o.review_lines ?? 0) > 0) {
    items.push({
      id: "review",
      tone: "info",
      title: `${n(o.review_lines)} lines counted with a medium-confidence rule`,
      body: "They are included in the figures; worth a look once.",
      href: "/ledger/quality",
      action: "Check them",
    })
  }
  return items
}

/** Plain observations about the month's shares. Each rule states its own line. */
/**
 * `ledgerHref` opens the marketplace profit screen for the same scope and month
 * (built by the page, which knows the scope's URL form).
 */
export function findings(o: Overview, currency: string, monthKey: string, ledgerHref: string): Finding[] {
  const out: Finding[] = []
  if (!o.has_marketplace_data) return out

  if (o.advertising_pct_of_net_sales !== null && o.advertising_pct_of_net_sales >= 10) {
    out.push({
      id: "ads-share",
      tone: "watch",
      title: "Advertising is a large share of sales",
      body: `Marketplace advertising was ${formatMoney(o.advertising, currency)}, ${formatPercent(o.advertising_pct_of_net_sales)} of net sales (this card appears at 10% or more).`,
      href: ledgerHref,
      action: "See the statement",
    })
  }
  if (o.refunds_pct_of_gross !== null && o.refunds_pct_of_gross >= 5) {
    out.push({
      id: "refunds",
      tone: "watch",
      title: "Refunds are eating into sales",
      body: `Refunds were ${formatMoney(o.sales_refunds, currency)}, ${formatPercent(o.refunds_pct_of_gross)} of gross sales (this card appears at 5% or more).`,
      href: ledgerHref,
      action: "See the statement",
    })
  }
  if (o.costs_pct_of_net_sales !== null) {
    out.push({
      id: "costs-share",
      tone: "info",
      title: "What the marketplaces keep",
      body: `Fees, fulfilment and advertising came to ${formatMoney(o.marketplace_costs, currency)}, ${formatPercent(o.costs_pct_of_net_sales)} of net sales.`,
      href: ledgerHref,
      action: "See the statement",
    })
  }
  if (o.contribution_margin_pct !== null) {
    out.push({
      id: "margin",
      tone: o.contribution_margin_pct > 0 ? "good" : "attention",
      title: "Contribution margin (final)",
      body: `You kept ${formatPercent(o.contribution_margin_pct)} of net sales after marketplace costs.`,
      href: `/ledger/products?month=${monthKey}`,
      action: "See product profit",
    })
  }
  if (o.expected_payouts > 0) {
    out.push({
      id: "payouts",
      tone: "info",
      title: "Expected payouts this month",
      body: `${formatNumber(o.expected_payouts)} payout${o.expected_payouts === 1 ? "" : "s"}, ${formatMoney(o.expected_inflow, currency)} expected. Not confirmed as received: no bank is connected.`,
      href: `/ledger/payouts?month=${monthKey}`,
      action: "See payouts",
    })
  }
  return out
}
