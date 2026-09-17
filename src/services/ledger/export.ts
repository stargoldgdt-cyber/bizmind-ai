import type { Database } from "@/types/database"

import { formatLedgerDay } from "./display"
import type { LedgerMonth } from "./period"

/**
 * The validation export: one CSV an owner can open next to the marketplace's
 * own reports.
 *
 * Every figure is written exactly as the database produced it (exact decimal
 * text). Nothing here adds, rounds or converts. Text cells are protected
 * against spreadsheet formula injection; money cells are never altered, so a
 * negative amount stays a number in the spreadsheet.
 */

type Fn = Database["public"]["Functions"]
export type PnlSummaryRow = Fn["pnl_summary"]["Returns"][number]
export type PnlBreakdownRow = Fn["pnl_breakdown"]["Returns"][number]
export type PnlSettlementRow = Fn["pnl_settlements"]["Returns"][number]
export type LedgerQualityRow = Fn["ledger_data_quality"]["Returns"][number]

export type CsvCell =
  | { kind: "text"; value: string | null | undefined }
  | { kind: "money"; value: string | null | undefined }
  | { kind: "count"; value: number | null | undefined }

export const text = (value: string | null | undefined): CsvCell => ({ kind: "text", value })
export const money = (value: string | null | undefined): CsvCell => ({ kind: "money", value })
export const count = (value: number | null | undefined): CsvCell => ({ kind: "count", value })

const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/
const FORMULA_START = /^[=+\-@\t\r]/

function renderCell(cell: CsvCell): string {
  if (cell.value === null || cell.value === undefined) return ""

  if (cell.kind === "money") {
    // Only exact decimal text leaves as a number; anything else is dropped
    // rather than written somewhere a spreadsheet would evaluate it.
    return EXACT_DECIMAL.test(cell.value) ? cell.value : ""
  }

  if (cell.kind === "count") {
    return Number.isInteger(cell.value) ? String(cell.value) : ""
  }

  let value = cell.value
  if (FORMULA_START.test(value)) value = `'${value}`
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Rows to CSV text, with a byte-order mark so spreadsheets read UTF-8. */
export function buildCsv(rows: CsvCell[][]): string {
  return `﻿${rows.map((row) => row.map(renderCell).join(",")).join("\r\n")}\r\n`
}

const STATUS = (status: string | null | undefined) => (status === "FINAL" ? "Final" : "Incomplete")

export type LedgerExportInput = {
  businessName: string
  accountLabel: string
  marketplaceCode: string
  currency: string
  month: LedgerMonth
  summary: PnlSummaryRow | null
  breakdown: PnlBreakdownRow[]
  settlements: PnlSettlementRow[]
  quality: LedgerQualityRow[]
}

export function ledgerExportRows(input: LedgerExportInput): CsvCell[][] {
  const { summary: s } = input
  const rows: CsvCell[][] = [
    [text("BizMind marketplace profit -- validation export")],
    [text("Business"), text(input.businessName)],
    [text("Account"), text(`${input.accountLabel} (${input.marketplaceCode})`)],
    [text("Currency"), text(input.currency)],
    [text("Period"), text(`${input.month.label} (UTC, by posted date)`)],
    [],
    [text("FIGURES"), text("Amount"), text("Status")],
  ]

  if (!s) {
    rows.push([text("No lines were posted in this period.")])
  } else {
    const figures = STATUS(s.figures_status)
    rows.push(
      [text("Gross sales"), money(s.gross_sales), text(figures)],
      [text("Sales refunds and returns"), money(s.sales_refunds), text(figures)],
      [text("Seller-funded discounts"), money(s.seller_discounts), text(figures)],
      [text("Net sales"), money(s.net_sales), text(figures)],
      [text("Other income"), money(s.other_income), text(figures)],
      [text("Marketplace fees"), money(s.marketplace_fees), text(figures)],
      [text("Fulfillment and storage"), money(s.fulfillment), text(figures)],
      [text("Advertising"), money(s.advertising), text(figures)],
      [text("Other marketplace costs"), money(s.other_marketplace_costs), text(figures)],
      [text("Non-recoverable VAT on fees"), money(s.non_recoverable_vat), text(figures)],
      [text("Contribution (before COGS and operating expenses)"), money(s.contribution), text(STATUS(s.contribution_status))],
      [text("Contribution before open items (informational, not final)"), money(s.contribution_before_open_items), text("Informational")],
      [text("Cost of goods sold (units sold x dated cost)"), money(s.cogs), text(STATUS(s.gross_profit_status))],
      [text("Gross profit (contribution - COGS)"), money(s.gross_profit), text(STATUS(s.gross_profit_status))],
      [text("Gross profit before open items (informational, not final)"), money(s.gross_profit_before_open_items), text("Informational")],
      [],
      [text("UNITS"), text("Quantity")],
      [text("Units sold"), money(s.units_sold)],
      [text("Units whose SKU is not mapped to a product"), money(s.units_without_product)],
      [text("Units whose product has no cost on the sale date"), money(s.units_without_cost)],
      [],
      [text("TAX (not in profit unless the VAT setting says so)"), text("Amount")],
      [text(`VAT setting for fees: ${s.input_vat_treatment}`)],
      [text("Input VAT, recoverable"), money(s.input_vat_recoverable)],
      [text("Input VAT, treatment unknown"), money(s.input_vat_unresolved)],
      [text("Output VAT"), money(s.output_vat)],
      [],
      [text("OPEN ITEMS"), text("Lines"), text("Amount")],
      [text("Not recognised"), count(s.unknown_lines), money(s.unknown_amount)],
      [text("Under review"), count(s.review_lines), money(s.review_amount)],
      [text("Waiting for the VAT setting"), count(s.conditional_lines)],
      [text("Unreadable rows in these files"), count(s.row_errors)],
      [text("Reasons incomplete"), text(s.incomplete_reasons.join(" / ") || "none")],
      [text("Reasons gross profit is incomplete"), text(s.gross_profit_reasons.join(" / ") || "none")],
    )
  }

  rows.push(
    [],
    [text("BREAKDOWN"), text("Type"), text("Category"), text("Line"), text("Code (if not recognised)"), text("Status"), text("P&L treatment"), text("Lines"), text("Total")],
    ...input.breakdown.map((b) => [
      text(""),
      text(b.financial_type),
      text(b.category_label),
      text(b.subcategory),
      text(b.match_key),
      text(b.classification_status),
      text(b.pnl_treatment),
      count(b.lines),
      money(b.total),
    ]),
    [],
    [text("SETTLEMENTS (as the marketplace reported them)"), text("Period start"), text("Period end"), text("Reported total"), text("Sum of all its lines"), text("Adds up"), text("Lines in this period"), text("Amount in this period"), text("Payout reported"), text("Payout date"), text("File")],
    ...input.settlements.map((st) => [
      text(st.external_settlement_id),
      text(formatLedgerDay(st.period_start)),
      text(formatLedgerDay(st.period_end)),
      money(st.reported_total),
      money(st.lines_total),
      text(st.reconciles ? "Yes" : "No"),
      count(st.lines_in_period_count),
      money(st.lines_in_period),
      money(st.payout_amount),
      text(formatLedgerDay(st.payout_date)),
      text(st.file_name),
    ]),
    [],
    [text("DATA QUALITY"), text("Kind"), text("Reference"), text("Lines"), text("Amount"), text("Detail")],
    ...input.quality.map((q) => [
      text(""),
      text(q.issue_kind),
      text(q.reference),
      count(q.lines),
      money(q.amount),
      text(q.detail),
    ]),
  )

  return rows
}
