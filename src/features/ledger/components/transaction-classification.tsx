"use client"

import Link from "next/link"
import { useState } from "react"
import { CircleAlert } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "cn"
import { formatMoney, formatNumber } from "@/lib/format"
import { CLASSIFICATION_STATUS_LABEL, FINANCIAL_TYPE_LABEL, TREATMENT_LABEL } from "@/services/ledger/display"
import type { PnlBreakdownRow } from "@/services/ledger/export"

/**
 * "Transaction Classification" (formerly "Where every line went"): the same
 * pnl_breakdown() rows, unchanged, with filter chips over the universal
 * reporting groups every marketplace's lines are classified into. Filtering
 * is a client-side string match on `metric_group`, already computed in SQL --
 * nothing here re-classifies a line or recalculates a total.
 */

export type BreakdownRow = PnlBreakdownRow & { href?: string }

type FilterKey = "ALL" | "REVENUE" | "REFUNDS" | "DISCOUNTS" | "FEES" | "FULFILMENT" | "ADVERTISING" | "TAX" | "OTHER"

const FILTERS: { key: FilterKey; label: string; groups: readonly string[] }[] = [
  { key: "ALL", label: "All", groups: [] },
  { key: "REVENUE", label: "Revenue", groups: ["GROSS_SALES", "OTHER_INCOME"] },
  { key: "REFUNDS", label: "Refunds", groups: ["SALES_REFUNDS"] },
  { key: "DISCOUNTS", label: "Discounts", groups: ["SELLER_DISCOUNTS"] },
  { key: "FEES", label: "Marketplace Fees", groups: ["MARKETPLACE_FEES"] },
  { key: "FULFILMENT", label: "Fulfillment & Logistics", groups: ["FULFILLMENT"] },
  { key: "ADVERTISING", label: "Advertising", groups: ["ADVERTISING"] },
  { key: "TAX", label: "Taxes", groups: ["INPUT_VAT", "OUTPUT_VAT"] },
  { key: "OTHER", label: "Other Marketplace Costs", groups: ["OTHER_MARKETPLACE_COSTS"] },
]

export function TransactionClassification({ rows, currency }: { rows: BreakdownRow[]; currency: string }) {
  const [active, setActive] = useState<FilterKey>("ALL")
  const money = (value: string | null | undefined) => formatMoney(value, currency)

  const counts = new Map<FilterKey, number>(
    FILTERS.map((f) => [
      f.key,
      f.key === "ALL"
        ? rows.length
        : rows.filter((r) => r.metric_group !== null && (f.groups as readonly (string | null)[]).includes(r.metric_group)).length,
    ])
  )
  const activeGroups = FILTERS.find((f) => f.key === active)?.groups ?? []
  const shown = active === "ALL" ? rows : rows.filter((r) => activeGroups.includes(r.metric_group ?? ""))

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 border-b border-border px-5 py-3">
        {FILTERS.filter((f) => f.key === "ALL" || (counts.get(f.key) ?? 0) > 0).map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setActive(f.key)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              active === f.key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
            )}
          >
            {f.label}
            <span className="ml-1 tabular-nums opacity-70">{counts.get(f.key)}</span>
          </button>
        ))}
      </div>
      <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Line</TableHead>
              <TableHead>Counts as</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row) => {
              const unknown = row.classification_status === "UNKNOWN"
              const cells = (
                <>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.financial_type ? FINANCIAL_TYPE_LABEL[row.financial_type] : "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {unknown ? (
                      <span className="inline-flex items-center gap-1 text-warning-strong">
                        <CircleAlert className="size-3.5" aria-hidden />
                        {CLASSIFICATION_STATUS_LABEL.UNKNOWN}
                      </span>
                    ) : (
                      row.category_label
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.href ? (
                      <Link href={row.href} className="underline-offset-4 hover:underline">
                        {unknown ? <span className="font-mono text-xs">{row.match_key}</span> : row.subcategory}
                      </Link>
                    ) : unknown ? (
                      <span className="font-mono text-xs">{row.match_key}</span>
                    ) : (
                      row.subcategory
                    )}
                    {row.classification_status === "UNDER_REVIEW" && (
                      <span className="ml-2 text-[11px] text-info-strong">Under review</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.pnl_treatment ? TREATMENT_LABEL[row.pnl_treatment] : "Nothing yet"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{formatNumber(row.lines)}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">{money(row.total)}</TableCell>
                </>
              )
              return <TableRow key={`${row.category}-${row.subcategory}-${row.match_key}-${row.classification_status}`}>{cells}</TableRow>
            })}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                  Nothing in this group for the period.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
