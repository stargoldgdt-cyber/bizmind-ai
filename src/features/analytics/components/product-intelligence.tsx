"use client"

import { useMemo, useState } from "react"
import { Calculator, ChevronDown, TriangleAlert } from "lucide-react"

import { cn } from "cn"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import type { ProductPerformance } from "@/services/analytics"
import { compareMoney } from "@/services/analytics/money"

/**
 * Product Intelligence: which products earn, which ones only sell, and which
 * ones cannot be judged at all.
 *
 * SORTING COMPARES, IT DOES NOT CALCULATE.
 * Ordering by revenue or profit goes through `compareMoney`, which compares
 * exact decimal strings digit by digit. Converting them to numbers to sort
 * would round exactly the figures this product exists to keep exact.
 *
 * THE VIEWS ARE QUESTIONS, NOT FILTERS.
 * "Lowest margin" and "No recorded cost" are the two questions an owner asks
 * after seeing the top sellers, so they are one click rather than a sort the
 * owner has to think of.
 *
 * A product whose lines have no recorded value is never shown as earning zero:
 * it appears under "No recorded value" with its figures blank, because that is
 * what BizMind knows about it.
 */

type View = "all" | "profit" | "low_margin" | "missing_cost" | "unknown_value"

const VIEWS: { key: View; label: string }[] = [
  { key: "all", label: "Top by revenue" },
  { key: "profit", label: "Top by profit" },
  { key: "low_margin", label: "Lowest margin" },
  { key: "missing_cost", label: "No recorded cost" },
  { key: "unknown_value", label: "No recorded value" },
]

export function ProductIntelligence({
  products,
  currency,
  limit = 12,
}: {
  products: ProductPerformance[]
  currency: string
  limit?: number
}) {
  const [view, setView] = useState<View>("all")
  const [expanded, setExpanded] = useState<string | null>(null)

  const rows = useMemo(() => {
    const measured = (p: ProductPerformance) => p.revenue !== null

    if (view === "missing_cost") {
      return products.filter(
        (p) => p.items_measured > 0 && p.items_with_cost < p.items_measured
      )
    }
    if (view === "unknown_value") {
      return products.filter((p) => p.items_value_unknown > 0)
    }
    if (view === "low_margin") {
      return products
        .filter((p) => p.gross_margin !== null && measured(p))
        // Ascending, comparing exact decimal text rather than converting it.
        .sort((a, b) => compareMoney(a.gross_margin, b.gross_margin))
    }
    if (view === "profit") {
      return products
        .filter(measured)
        .sort((a, b) => compareMoney(b.gross_profit, a.gross_profit))
    }
    return [...products].sort((a, b) => compareMoney(b.revenue, a.revenue))
  }, [products, view])

  const shown = rows.slice(0, limit)

  if (products.length === 0) {
    return (
      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
        No product lines in this period. If your orders were imported with
        totals but no line items, there is nothing to break down here.
      </p>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 border-b border-border px-4 pb-3">
        {VIEWS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setView(option.key)}
            aria-pressed={view === option.key}
            className={cn(
              "rounded-4xl px-3 py-1.5 text-xs font-medium transition-colors",
              view === option.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          Nothing to show here — which in this case is good news.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((product) => {
            const open = expanded === product.product_key
            const coverage =
              product.cost_coverage === null ? null : Number(product.cost_coverage)
            const incompleteCost = coverage !== null && coverage < 100

            return (
              <li key={product.product_key}>
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : product.product_key)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {product.product_name}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {product.name_source === "NONE"
                        ? "No SKU or name on these lines"
                        : product.name_source === "SKU"
                          ? "No product name recorded"
                          : (product.sku ?? "")}
                    </span>
                  </span>

                  <span className="hidden text-right sm:block">
                    <span className="block font-mono text-xs tabular-nums">
                      {formatMoney(product.revenue, currency)}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">revenue</span>
                  </span>

                  <span className="w-24 text-right">
                    <span className="block font-mono text-xs font-medium tabular-nums">
                      {formatMoney(product.gross_profit, currency)}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">profit</span>
                  </span>

                  <span className="w-16 text-right font-mono text-xs tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      {incompleteCost && (
                        <TriangleAlert
                          className="size-3 text-warning-strong"
                          aria-label="Some of this product's sales have no recorded cost"
                        />
                      )}
                      {product.items_value_derived > 0 && (
                        <Calculator
                          className="size-3 text-muted-foreground"
                          aria-label="Part of this product's revenue was calculated from quantity and unit price"
                        />
                      )}
                      {formatPercent(product.gross_margin)}
                    </span>
                  </span>

                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      open && "rotate-180"
                    )}
                    aria-hidden
                  />
                </button>

                {open && <Detail product={product} currency={currency} />}
              </li>
            )
          })}
        </ul>
      )}

      {rows.length > limit && (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Showing {limit} of {rows.length} products.
        </p>
      )}
    </div>
  )
}

function Detail({
  product,
  currency,
}: {
  product: ProductPerformance
  currency: string
}) {
  const facts: { label: string; value: string }[] = [
    { label: "Revenue", value: formatMoney(product.revenue, currency) },
    { label: "Units sold", value: formatNumber(product.units_sold, 2) },
    { label: "Cost of goods", value: formatMoney(product.cogs, currency) },
    { label: "Fees (allocated)", value: formatMoney(product.fees_allocated, currency) },
    { label: "Gross profit", value: formatMoney(product.gross_profit, currency) },
    { label: "Margin", value: formatPercent(product.gross_margin) },
    { label: "Orders", value: formatNumber(product.orders_count) },
    { label: "Order lines", value: formatNumber(product.items_total) },
  ]

  const notes: string[] = []

  if (product.items_with_cost < product.items_measured) {
    notes.push(
      `${formatNumber(product.items_measured - product.items_with_cost)} of ${formatNumber(
        product.items_measured
      )} measured lines have no recorded cost, so this profit is higher than reality.`
    )
  }
  if (product.items_value_derived > 0) {
    notes.push(
      `${formatMoney(product.revenue_derived, currency)} of the revenue was calculated as quantity × unit price, because the source gave no line total.`
    )
  }
  if (product.items_value_unknown > 0) {
    notes.push(
      `${formatNumber(product.items_value_unknown)} line${
        product.items_value_unknown === 1 ? "" : "s"
      } have no line total and no unit price, so their value is unknown and left out entirely — not counted as zero.`
    )
  }
  if (product.name_source === "CATALOGUE") {
    notes.push("Named from your product catalogue.")
  }
  if (product.name_source === "NONE") {
    notes.push(
      "These order lines carry no SKU, product link or name, so they cannot be told apart. Adding a SKU column to your import fixes this."
    )
  }

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt className="text-[11px] text-muted-foreground">{fact.label}</dt>
            <dd className="font-mono text-sm tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {notes.map((note) => (
            <li key={note} className="text-xs text-muted-foreground">
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
