import type { Database } from "@/types/database"

import { BANK_RECEIPT_LABEL, BANK_RECEIPT_STATUS_LABEL, EXPECTED_PAYOUT_LABEL, PAYOUT_STATUS_LABEL } from "../payouts/labels"

/**
 * The report catalogue (GCC Phase 8).
 *
 * A report is a set of sheets built from figures the database already
 * computed. Nothing here calculates: every money cell is the exact text SQL
 * produced, and an incomplete figure is an empty cell with its status beside
 * it. The same report object is written to Excel (./xlsx.ts) and, later, to a
 * Google Sheet BizMind creates.
 */

type Fn = Database["public"]["Functions"]
type SummaryRow = Fn["pnl_summary"]["Returns"][number]
type ProductRow = Fn["pnl_by_product"]["Returns"][number]
type NetRow = Fn["pnl_net_profit"]["Returns"][number]
type ExpenseRow = Fn["expense_breakdown"]["Returns"][number]
type PayoutRow = Fn["expected_payouts"]["Returns"][number]
type CashflowRow = Fn["expected_cashflow"]["Returns"][number]
type QualityRow = Fn["ledger_data_quality"]["Returns"][number]

export const REPORT_KEYS = ["marketplace-profit", "product-profit", "net-profit", "payouts", "data-quality"] as const
export type ReportKey = (typeof REPORT_KEYS)[number]

export function isReportKey(value: unknown): value is ReportKey {
  return typeof value === "string" && (REPORT_KEYS as readonly string[]).includes(value)
}

export const REPORT_CATALOG: Record<ReportKey, { title: string; description: string; monthly: boolean }> = {
  "marketplace-profit": {
    title: "Marketplace profit",
    description: "Every marketplace account and each currency's total: sales, fees, contribution, cost of goods and gross profit, with their status.",
    monthly: true,
  },
  "product-profit": {
    title: "Product profit",
    description: "Each product and unmatched SKU, with the lines not allocated to a product, per currency.",
    monthly: true,
  },
  "net-profit": {
    title: "Operating expenses and net profit",
    description: "Net profit per currency, and every expense category with how it counts.",
    monthly: true,
  },
  payouts: {
    title: "Expected payouts and cashflow",
    description: "Payouts the marketplaces report, with their checks. Expected, never received: no bank is connected.",
    monthly: true,
  },
  "data-quality": {
    title: "Open data quality items",
    description: "Everything that keeps a figure from being final, in every period.",
    monthly: false,
  },
}

export type CellKind = "text" | "money" | "count" | "percent" | "date"
export type Cell = string | number | null
export type ReportSheet = {
  name: string
  columns: { header: string; kind: CellKind; width?: number }[]
  rows: Cell[][]
}
export type Report = {
  key: ReportKey
  title: string
  /** Lines for the About sheet: what the report is and how to read it. */
  about: [string, string][]
  sheets: ReportSheet[]
}

const STATUS = (value: string | null | undefined) => (value === "FINAL" ? "Final" : "Incomplete")

export function aboutLines(input: { businessName: string; period: string; generatedAt: string }): [string, string][] {
  return [
    ["Business", input.businessName],
    ["Period", input.period],
    ["Generated", input.generatedAt],
    ["Figures", "Computed by BizMind in the database from the marketplaces' own reports. Nothing is estimated."],
    ["Blank figure", "Not final. Its status column says why; never read a blank as zero."],
    ["Signs", "Money in is positive; fees, refunds and costs are negative."],
  ]
}

export function marketplaceProfitSheets(perAccount: SummaryRow[], perCurrency: SummaryRow[]): ReportSheet[] {
  const columns: ReportSheet["columns"] = [
    { header: "Account", kind: "text", width: 26 },
    { header: "Marketplace", kind: "text" },
    { header: "Currency", kind: "text" },
    { header: "Gross sales", kind: "money" },
    { header: "Refunds", kind: "money" },
    { header: "Seller discounts", kind: "money" },
    { header: "Net sales", kind: "money" },
    { header: "Other income", kind: "money" },
    { header: "Marketplace fees", kind: "money" },
    { header: "Fulfilment", kind: "money" },
    { header: "Advertising", kind: "money" },
    { header: "Other marketplace costs", kind: "money" },
    { header: "Non-recoverable VAT", kind: "money" },
    { header: "Contribution", kind: "money" },
    { header: "Contribution status", kind: "text" },
    { header: "Units sold", kind: "count" },
    { header: "Cost of goods sold", kind: "money" },
    { header: "Gross profit", kind: "money" },
    { header: "Gross profit status", kind: "text" },
    { header: "Why not final", kind: "text", width: 40 },
    { header: "Input VAT, recoverable", kind: "money" },
    { header: "Input VAT, setting unknown", kind: "money" },
    { header: "Output VAT", kind: "money" },
  ]
  const row = (s: SummaryRow): Cell[] => [
    s.account_label, s.marketplace_code, s.currency, s.gross_sales, s.sales_refunds, s.seller_discounts, s.net_sales,
    s.other_income, s.marketplace_fees, s.fulfillment, s.advertising, s.other_marketplace_costs, s.non_recoverable_vat,
    s.contribution, STATUS(s.contribution_status), s.units_sold, s.gross_profit === null ? null : s.cogs, s.gross_profit,
    STATUS(s.gross_profit_status), s.gross_profit_reasons.join(", "), s.input_vat_recoverable, s.input_vat_unresolved,
    s.output_vat,
  ]
  return [
    { name: "By account", columns, rows: perAccount.map(row) },
    { name: "By currency", columns, rows: perCurrency.map(row) },
  ]
}

const PRODUCT_KIND: Record<ProductRow["row_kind"], string> = {
  PRODUCT: "Product",
  UNMAPPED_SKU: "SKU not matched",
  NOT_ALLOCATED: "Not allocated to a product",
}

export function productProfitSheets(rows: ProductRow[]): ReportSheet[] {
  return [{
    name: "Products",
    columns: [
      { header: "Currency", kind: "text" },
      { header: "Row", kind: "text", width: 22 },
      { header: "Product", kind: "text", width: 30 },
      { header: "Category", kind: "text" },
      { header: "Marketplace SKU", kind: "text", width: 22 },
      { header: "Marketplace", kind: "text" },
      { header: "Units sold", kind: "count" },
      { header: "Net sales", kind: "money" },
      { header: "Other income", kind: "money" },
      { header: "Marketplace costs", kind: "money" },
      { header: "Contribution", kind: "money" },
      { header: "Cost of goods sold", kind: "money" },
      { header: "Gross profit", kind: "money" },
      { header: "Gross margin %", kind: "percent" },
      { header: "Cost status", kind: "text" },
    ],
    rows: rows.map((r) => [
      r.currency, PRODUCT_KIND[r.row_kind], r.product_name, r.product_category, r.raw_sku, r.marketplace_code,
      r.row_kind === "NOT_ALLOCATED" ? null : r.units_sold, r.net_sales, r.other_income, r.costs, r.contribution,
      r.cogs, r.gross_profit, r.gross_margin_percent, r.cogs_status,
    ]),
  }]
}

const COST_CLASS: Record<ExpenseRow["cost_class"], string> = {
  OPERATING: "Operating expense",
  ADVERTISING: "Advertising outside the marketplaces",
  NOT_PROFIT: "Not counted in profit",
  UNCLASSIFIED: "Not classified yet",
}

export function netProfitSheets(net: NetRow[], expenses: ExpenseRow[]): ReportSheet[] {
  return [
    {
      name: "Net profit",
      columns: [
        { header: "Currency", kind: "text" },
        { header: "Marketplace accounts", kind: "count" },
        { header: "Contribution", kind: "money" },
        { header: "Gross profit", kind: "money" },
        { header: "Gross profit status", kind: "text" },
        { header: "Operating expenses", kind: "money" },
        { header: "Advertising outside the marketplaces", kind: "money" },
        { header: "Net profit", kind: "money" },
        { header: "Net profit status", kind: "text" },
        { header: "Why not final", kind: "text", width: 40 },
        { header: "Recorded, not in profit", kind: "money" },
        { header: "Expenses not classified", kind: "count" },
      ],
      rows: net.map((n) => [
        n.currency, n.accounts, n.contribution, n.gross_profit, STATUS(n.gross_profit_status), n.operating_expenses,
        n.external_advertising, n.net_profit, STATUS(n.net_profit_status), n.net_profit_reasons.join(", "),
        n.not_in_profit, n.unclassified_expense_lines,
      ]),
    },
    {
      name: "Expenses",
      columns: [
        { header: "Currency", kind: "text" },
        { header: "Counts as", kind: "text", width: 34 },
        { header: "Category", kind: "text", width: 34 },
        { header: "Expenses", kind: "count" },
        { header: "Total", kind: "money" },
      ],
      rows: expenses.map((e) => [
        e.currency, COST_CLASS[e.cost_class], e.category_label ?? e.category_name ?? "(no category)", e.lines, e.total,
      ]),
    },
  ]
}

export function payoutSheets(payouts: PayoutRow[], cashflow: CashflowRow[]): ReportSheet[] {
  const notConnected = BANK_RECEIPT_STATUS_LABEL.NOT_CONNECTED
  return [
    {
      name: "Expected payouts",
      columns: [
        { header: "Account", kind: "text", width: 22 },
        { header: "Currency", kind: "text" },
        { header: "Reference", kind: "text", width: 24 },
        { header: "Period start", kind: "date" },
        { header: "Period end", kind: "date" },
        { header: "Expected on", kind: "date" },
        { header: EXPECTED_PAYOUT_LABEL, kind: "money", width: 26 },
        { header: "Marketplace check", kind: "text", width: 26 },
        { header: "Sum of settlement lines", kind: "money" },
        { header: BANK_RECEIPT_LABEL, kind: "text", width: 20 },
      ],
      rows: payouts.map((p) => [
        p.account_label, p.currency, p.reference, p.period_start, p.period_end, p.expected_date, p.expected_amount,
        PAYOUT_STATUS_LABEL[p.marketplace_status], p.settlement_lines_total, notConnected,
      ]),
    },
    {
      name: "Expected cashflow",
      columns: [
        { header: "Month", kind: "date" },
        { header: "Currency", kind: "text" },
        { header: "Expected payouts", kind: "count" },
        { header: "Expected inflow", kind: "money" },
        { header: "Of which in doubt", kind: "money" },
        { header: "Payouts without an amount", kind: "count" },
        { header: BANK_RECEIPT_LABEL, kind: "text", width: 20 },
      ],
      rows: cashflow.map((c) => [
        c.month, c.currency, c.expected_payouts, c.expected_inflow, c.amount_in_doubt, c.payouts_without_amount, notConnected,
      ]),
    },
  ]
}

export function dataQualitySheets(rows: QualityRow[]): ReportSheet[] {
  return [{
    name: "Open items",
    columns: [
      { header: "Kind", kind: "text", width: 26 },
      { header: "Marketplace", kind: "text" },
      { header: "Account", kind: "text", width: 22 },
      { header: "Reference", kind: "text", width: 30 },
      { header: "Lines", kind: "count" },
      { header: "Amount", kind: "money" },
      { header: "Detail", kind: "text", width: 60 },
    ],
    rows: rows.map((q) => [q.issue_kind, q.marketplace_code, q.account_label, q.reference, q.lines, q.amount, q.detail]),
  }]
}

/** The figures a report is built from, exactly as the SQL readers return them. */
export type ReportData = {
  perAccount?: SummaryRow[]
  perCurrency?: SummaryRow[]
  products?: ProductRow[]
  net?: NetRow[]
  expenses?: ExpenseRow[]
  payouts?: PayoutRow[]
  cashflow?: CashflowRow[]
  quality?: QualityRow[]
}

/** One report's sheets, for the Excel download and the Google Sheets export alike. */
export function reportSheets(key: ReportKey, data: ReportData): ReportSheet[] {
  switch (key) {
    case "marketplace-profit":
      return marketplaceProfitSheets(data.perAccount ?? [], data.perCurrency ?? [])
    case "product-profit":
      return productProfitSheets(data.products ?? [])
    case "net-profit":
      return netProfitSheets(data.net ?? [], data.expenses ?? [])
    case "payouts":
      return payoutSheets(data.payouts ?? [], data.cashflow ?? [])
    case "data-quality":
      return dataQualitySheets(data.quality ?? [])
  }
}

/** The About lines for one report and period. */
export function reportAbout(key: ReportKey, businessName: string, monthKey: string | null, monthLabel: string | null): [string, string][] {
  return aboutLines({
    businessName,
    period: REPORT_CATALOG[key].monthly && monthKey ? `${monthLabel ?? monthKey} (UTC, by posted date)` : "All periods",
    generatedAt: `${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`,
  })
}
