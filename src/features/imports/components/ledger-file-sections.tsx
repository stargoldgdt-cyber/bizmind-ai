import { CircleAlert, CircleCheck } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { LedgerFileCategory, LedgerFileSettlement } from "@/features/imports/queries"
import { formatMoney, formatNumber } from "@/lib/format"

/**
 * What a marketplace settlement file put into the ledger.
 *
 * Two questions, both answered with figures the database added up:
 *   1. what is in this file? (lines and exact totals per kind)
 *   2. does it agree with itself? (the marketplace's total against its lines)
 *
 * This is evidence about one file, not a P&L. Profit is Phase 3, and VAT on
 * fees is shown on its own line because whether it counts is decision B1.
 */

const SIDE_LABEL: Record<string, string> = {
  PNL: "Profit and loss",
  CASH: "Cash movements",
  TAX: "Tax",
  MEMO: "For reference",
}

const KIND_LABEL: Record<string, string> = {
  "REVENUE.principal": "Product sales",
  "REVENUE.shipping_charged": "Shipping charged to buyers",
  "REFUND.principal": "Refunded sales",
  "REFUND.shipping_charged": "Refunded shipping",
  "OTHER_INCOME.cod_charge": "Cash-on-delivery charges",
  "MARKETPLACE_FEE.referral": "Referral commission",
  "MARKETPLACE_FEE.closing": "Closing fees",
  "MARKETPLACE_FEE.cod": "Cash-on-delivery fees",
  "MARKETPLACE_FEE.refund_administration": "Refund administration fees",
  "MARKETPLACE_FEE.premium_services": "Premium services (SP 360)",
  "FULFILMENT.fba_per_unit": "FBA fulfilment",
  "FULFILMENT.shipping_chargeback": "Shipping chargebacks",
  "FULFILMENT.storage": "FBA storage",
  "PROMOTION.shipping": "Shipping promotions",
  "ADVERTISING.sponsored_ads": "Sponsored ads",
  "FEE_VAT.premium_services": "VAT on premium services",
}

function kindLabel(row: LedgerFileCategory): string {
  if (row.category === "UNMAPPED") return "Not recognised yet"
  return KIND_LABEL[`${row.category}.${row.subcategory}`] ?? `${row.category} · ${row.subcategory ?? "—"}`
}

export function LedgerFileContents({ summary }: { summary: LedgerFileCategory[] }) {
  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">What is in this file</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every line, grouped by what the marketplace says it is, with totals
          exactly as reported. Lines BizMind does not recognise yet are kept and
          count towards no figure.
        </p>
      </div>

      {summary.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">This file holds no lines.</p>
      ) : (
        <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Counts towards</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.map((row) => (
                <TableRow key={`${row.side}-${row.category}-${row.subcategory}-${row.currency}`}>
                  <TableCell className="text-sm">
                    {row.category === "UNMAPPED" ? (
                      <span className="inline-flex items-center gap-1 text-warning-strong">
                        <CircleAlert className="size-3.5" aria-hidden />
                        {kindLabel(row)}
                      </span>
                    ) : (
                      kindLabel(row)
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.side ? SIDE_LABEL[row.side] : "Nothing, until recognised"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatNumber(row.lines)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {formatMoney(row.total, row.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

export function LedgerFileSettlements({ settlements }: { settlements: LedgerFileSettlement[] }) {
  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">Settlements in this file</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The total the marketplace reported, checked against the sum of every
          line BizMind recorded. The payout is what the marketplace says it sent;
          whether it reached your bank is a separate check, later.
        </p>
      </div>

      {settlements.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">No settlement was read from this file.</p>
      ) : (
        <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Settlement</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Reported total</TableHead>
                <TableHead className="text-right">Sum of lines</TableHead>
                <TableHead>Check</TableHead>
                <TableHead className="text-right">Payout reported</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {settlements.map((settlement) => (
                <TableRow key={settlement.settlement_id}>
                  <TableCell className="font-mono text-xs">{settlement.external_settlement_id}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {settlement.period_start ? new Date(settlement.period_start).toLocaleDateString() : "—"} –{" "}
                    {settlement.period_end ? new Date(settlement.period_end).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {formatMoney(settlement.reported_total, settlement.currency)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {formatMoney(settlement.lines_total, settlement.currency)}
                  </TableCell>
                  <TableCell>
                    {settlement.reconciles ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-success-strong">
                        <CircleCheck className="size-3.5" aria-hidden />
                        Adds up
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-danger-strong">
                        <CircleAlert className="size-3.5" aria-hidden />
                        Does not add up
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {formatMoney(settlement.payout_amount, settlement.currency)}
                    {settlement.reported_deposit_date && (
                      <span className="block text-[11px] text-muted-foreground">
                        {new Date(settlement.reported_deposit_date).toLocaleDateString()}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
