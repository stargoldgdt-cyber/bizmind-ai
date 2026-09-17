import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { compareMoney } from "@/services/analytics/money"
import type { Database } from "@/types/database"

/**
 * The ledger fact sheet (GCC Phase 9).
 *
 * COMPUTE FIRST, THEN NARRATE -- on the marketplace ledger.
 *
 * Each question an owner can ask is bound to figures the SQL readers already
 * produced for one month. This module only chooses which of those figures a
 * question needs and writes them as labelled lines, formatted exactly as the
 * screens show them. It never adds, subtracts or derives a figure: ordering
 * uses the exact decimal comparator, and a count is the number of rows the
 * database returned.
 *
 * TWO RULES THE TEXT ITSELF CARRIES
 *   * A figure that is not final is written as "NOT FINAL" with its reasons;
 *     an informational figure is labelled "so far, NOT FINAL".
 *   * An expected payout is labelled "expected, NOT received"; the bank line
 *     always reads "not connected".
 */

type Fn = Database["public"]["Functions"]
type SummaryRow = Fn["pnl_summary"]["Returns"][number]
type NetRow = Fn["pnl_net_profit"]["Returns"][number]
type ProductRow = Fn["pnl_by_product"]["Returns"][number]
type QualityRow = Fn["ledger_data_quality"]["Returns"][number]
type PayoutRow = Fn["expected_payouts"]["Returns"][number]
type ExpenseRow = Fn["expense_breakdown"]["Returns"][number]

export const LEDGER_QUESTIONS = {
  "month-summary": "How did my marketplaces do this month?",
  "not-final": "Why are some of my figures not final?",
  marketplaces: "Which marketplace account is doing best?",
  products: "Which products make and lose the most?",
  payouts: "What payouts should I expect?",
  expenses: "Where are my operating expenses going?",
} as const

export type LedgerQuestion = keyof typeof LEDGER_QUESTIONS

export function isLedgerQuestion(value: unknown): value is LedgerQuestion {
  return typeof value === "string" && Object.hasOwn(LEDGER_QUESTIONS, value)
}

/** The readers each question needs, so nothing else is fetched or shown. */
export const QUESTION_NEEDS: Record<LedgerQuestion, readonly (keyof LedgerFactInput)[]> = {
  "month-summary": ["perCurrency", "net"],
  "not-final": ["perCurrency", "net", "quality"],
  marketplaces: ["perAccount"],
  products: ["products"],
  payouts: ["payouts"],
  expenses: ["net", "expenses"],
}

export type LedgerFactInput = {
  businessName: string
  monthLabel: string
  perAccount?: SummaryRow[]
  perCurrency?: SummaryRow[]
  net?: NetRow[]
  products?: ProductRow[]
  quality?: QualityRow[]
  payouts?: PayoutRow[]
  expenses?: ExpenseRow[]
}

const REASON: Record<string, string> = {
  UNKNOWN_LINES: "some marketplace lines are not recognised yet",
  VAT_TREATMENT_UNKNOWN: "the VAT setting for marketplace fees has not been chosen",
  FEE_VAT_NOT_SEPARATED: "marketplace fees still include VAT because the VAT invoices are missing",
  ROW_ERRORS: "some rows in the uploaded files could not be read",
  SKU_NOT_MAPPED: "some marketplace SKUs are not matched to a product",
  COST_MISSING: "some products have no cost for the sale date",
  NO_MARKETPLACE_DATA: "there are no marketplace figures for this month",
  EXPENSES_UNCLASSIFIED: "some expense categories have not been placed",
}

const QUALITY_KIND: Record<string, string> = {
  UNKNOWN_CODE: "Marketplace code not recognised",
  UNDER_REVIEW: "Lines counted with a medium-confidence rule",
  VAT_TREATMENT_UNKNOWN: "VAT setting for fees not chosen",
  FEE_VAT_NOT_SEPARATED: "Fees still include VAT",
  ROW_ERRORS: "Rows that could not be read",
  SETTLEMENT_MISMATCH: "Settlement does not add up",
}

const reasons = (codes: readonly string[]) => codes.map((c) => REASON[c] ?? c).join("; ")

/** A figure that is only shown when final. */
function finalOr(value: string | null, currency: string, why: readonly string[], soFar?: string): string {
  if (value !== null) return `${formatMoney(value, currency)} (final)`
  const informational = soFar ? `; so far, NOT FINAL: ${formatMoney(soFar, currency)}` : ""
  return `NOT FINAL -- ${reasons(why) || "not all figures are in"}${informational}`
}

function currencyBlock(s: SummaryRow, net: NetRow | undefined): string[] {
  const m = (v: string | null | undefined) => formatMoney(v, s.currency)
  const lines = [
    `- Accounts in ${s.currency}: ${formatNumber(s.accounts)}`,
    `- Gross sales: ${m(s.gross_sales)}`,
    `- Net sales (after refunds and discounts): ${m(s.net_sales)}`,
    `- Marketplace fees: ${m(s.marketplace_fees)}`,
    `- Fulfilment: ${m(s.fulfillment)}`,
    `- Marketplace advertising: ${m(s.advertising)}`,
    `- Contribution: ${finalOr(s.contribution, s.currency, s.incomplete_reasons, s.contribution_before_open_items)}`,
    `- Units sold: ${formatNumber(s.units_sold, 4)}`,
    `- Gross profit: ${finalOr(s.gross_profit, s.currency, s.gross_profit_reasons, s.gross_profit_before_open_items)}`,
  ]
  if (net) {
    lines.push(
      `- Operating expenses: ${m(net.operating_expenses)}`,
      `- Advertising outside the marketplaces: ${m(net.external_advertising)}`,
      `- Net profit: ${finalOr(net.net_profit, net.currency, net.net_profit_reasons, net.net_profit_before_open_items)}`
    )
  }
  return lines
}

/** The text the model receives, and the only numbers it may repeat. */
export function buildLedgerFactText(question: LedgerQuestion, input: LedgerFactInput): string {
  const lines: string[] = [
    `BUSINESS: ${input.businessName}`,
    `MONTH: ${input.monthLabel} (UTC)`,
    `QUESTION: ${LEDGER_QUESTIONS[question]}`,
    "SOURCE: the marketplaces' own reports, classified and added up by BizMind's database.",
    "RULE: amounts in different currencies are never added together.",
  ]
  const section = (title: string, body: string[]) => {
    lines.push("", `## ${title}`, ...(body.length > 0 ? body : ["- Nothing recorded."]))
  }
  const netFor = (currency: string) => (input.net ?? []).find((n) => n.currency === currency)

  switch (question) {
    case "month-summary":
    case "not-final": {
      const totals = input.perCurrency ?? []
      for (const s of totals) section(`All marketplace accounts in ${s.currency}`, currencyBlock(s, netFor(s.currency)))
      for (const n of (input.net ?? []).filter((n) => !totals.some((s) => s.currency === n.currency))) {
        section(`Expenses in ${n.currency} (no marketplace figures this month)`, [
          `- Operating expenses: ${formatMoney(n.operating_expenses, n.currency)}`,
          `- Net profit: ${finalOr(n.net_profit, n.currency, n.net_profit_reasons)}`,
        ])
      }
      if (question === "not-final") {
        section(
          "Open data quality items (what to fix)",
          (input.quality ?? []).slice(0, 12).map((q) =>
            `- ${QUALITY_KIND[q.issue_kind] ?? q.issue_kind} -- ${q.account_label}` +
              (q.reference ? ` (${q.reference})` : "") +
              `: ${formatNumber(q.lines)} lines, ${formatMoney(q.amount, q.currency)}`
          )
        )
      }
      break
    }
    case "marketplaces": {
      section(
        "Each marketplace account",
        (input.perAccount ?? []).map((s) =>
          `- ${s.account_label} (${s.marketplace_code}, ${s.currency}): net sales ${formatMoney(s.net_sales, s.currency)}; ` +
            `fees ${formatMoney(s.marketplace_fees, s.currency)}; fulfilment ${formatMoney(s.fulfillment, s.currency)}; ` +
            `advertising ${formatMoney(s.advertising, s.currency)}; contribution ${finalOr(
              s.contribution, s.currency, s.incomplete_reasons, s.contribution_before_open_items
            )}; gross profit ${finalOr(s.gross_profit, s.currency, s.gross_profit_reasons)}`
        )
      )
      break
    }
    case "products": {
      const rows = input.products ?? []
      const costed = rows.filter((r) => r.row_kind === "PRODUCT" && r.gross_profit !== null)
      const describe = (r: ProductRow) =>
        `- ${r.product_name} (${r.currency}): ${formatNumber(r.units_sold, 4)} units, net sales ${formatMoney(r.net_sales, r.currency)}, ` +
        `gross profit ${formatMoney(r.gross_profit, r.currency)}` +
        (r.gross_margin_percent ? `, gross margin ${formatPercent(r.gross_margin_percent)}` : "")
      const best = [...costed].sort((a, b) => compareMoney(b.gross_profit ?? "0", a.gross_profit ?? "0")).slice(0, 3)
      const worst = [...costed].sort((a, b) => compareMoney(a.gross_profit ?? "0", b.gross_profit ?? "0")).slice(0, 3)
      section("Highest gross profit (products with a known cost)", best.map(describe))
      section("Lowest gross profit (products with a known cost)", worst.map(describe))
      const unmatched = rows.filter((r) => r.row_kind === "UNMAPPED_SKU")
      const uncosted = rows.filter((r) => r.row_kind === "PRODUCT" && r.gross_profit === null)
      section("Not judged", [
        `- Marketplace SKUs not matched to a product: ${formatNumber(unmatched.length)}`,
        `- Products without a cost for every sale: ${formatNumber(uncosted.length)}`,
        "- Account-level fees and advertising are never spread across products.",
      ])
      break
    }
    case "payouts": {
      section(
        "Expected marketplace payouts (from the marketplaces' reports; expected, NOT received)",
        (input.payouts ?? []).map((p) =>
          `- ${p.account_label}: ${p.expected_amount === null ? "no amount in the report" : formatMoney(p.expected_amount, p.currency)}` +
            ` expected on ${p.expected_date ? p.expected_date.slice(0, 10) : "an unstated date"}; ` +
            {
              ADDS_UP: "the settlement adds up",
              DOES_NOT_ADD_UP: `the settlement does NOT add up (its lines total ${formatMoney(p.settlement_lines_total, p.currency)})`,
              NO_TOTAL: "the report states no total",
              MARKETPLACE_PAYMENT: "a payment the marketplace reports sending",
            }[p.marketplace_status]
        )
      )
      section("Bank", ["- Actual bank receipts: not connected. BizMind cannot confirm that any payout reached the bank."])
      break
    }
    case "expenses": {
      for (const n of input.net ?? []) {
        section(`Expenses in ${n.currency}`, [
          `- Operating expenses: ${formatMoney(n.operating_expenses, n.currency)}`,
          `- Advertising outside the marketplaces: ${formatMoney(n.external_advertising, n.currency)}`,
          `- Recorded but not counted in profit (stock purchases, marketplace charges, tax, owner): ${formatMoney(n.not_in_profit, n.currency)}`,
          `- Expenses whose category is not placed yet: ${formatNumber(n.unclassified_expense_lines)} (${formatMoney(n.unclassified_expense_amount, n.currency)})`,
          `- Net profit: ${finalOr(n.net_profit, n.currency, n.net_profit_reasons, n.net_profit_before_open_items)}`,
        ])
      }
      const largest = [...(input.expenses ?? [])]
        .filter((e) => e.cost_class === "OPERATING" || e.cost_class === "ADVERTISING")
        .sort((a, b) => compareMoney(a.total, b.total))
        .slice(0, 5)
      section(
        "Largest expense categories",
        largest.map((e) => `- ${e.category_label ?? e.category_name ?? "(no category)"} (${e.currency}): ${formatMoney(e.total, e.currency)}`)
      )
      break
    }
  }

  // Plain spaces: Intl separates a currency code with a non-breaking one.
  return lines.join("\n").replace(/ /g, " ")
}
