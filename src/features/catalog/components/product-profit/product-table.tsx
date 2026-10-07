"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search, TrendingUp } from "lucide-react"

import { Button } from "@/components/ui/button"
import { formatMoney, formatNumber } from "@/lib/format"
import { compareMoney } from "@/services/analytics/money"
import {
  FILTER_CHIPS,
  FILTER_LABEL,
  STATUS_LABEL,
  filterCounts,
  matchesFilter,
  type FilterKey,
  type ProfitStatus,
  type ProfitViewRow,
} from "@/services/catalog/product-profit-view"

import { MarginChip } from "./margin-chip"
import { ProductThumb } from "./product-thumb"
import { StatusPill } from "./status-pill"

/**
 * Every product and unmatched SKU, with a health bar, chips, search, sorting
 * and paging.
 *
 * All of it happens in the browser over rows the server already worked out:
 * filtering, ordering and counting. Nothing here adds, subtracts or converts a
 * figure; ordering compares the exact decimal text, and the health bar's
 * segment widths are whole-number counts of products.
 *
 * Problems are loud and health is quiet (DESIGN.md: calm surface, sharp
 * signal): a loss or a thin margin tints its row and gets a coloured edge; a
 * healthy product gets neither.
 */

type SortKey = "name" | "units" | "netSales" | "costs" | "cogs" | "grossProfit" | "margin"
type Sort = { key: SortKey; direction: "asc" | "desc" }

const PAGE_SIZE = 25

/** The value a column sorts by. A figure that does not exist yet is null. */
function valueOf(row: ProfitViewRow, key: SortKey): string | null {
  return key === "name" ? row.name : row[key]
}

function compareRows(a: ProfitViewRow, b: ProfitViewRow, sort: Sort): number {
  const left = valueOf(a, sort.key)
  const right = valueOf(b, sort.key)
  // A figure that does not exist yet sorts last, whichever way the column runs.
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1
  const order = sort.key === "name" ? left.localeCompare(right) : compareMoney(left, right)
  return sort.direction === "asc" ? order : -order
}

/** How each group looks: its row tint, its coloured edge, and its health-bar segment. */
const LOOK: Record<ProfitStatus, { row: string; edge: string; bar: string; segment: string; filter: FilterKey }> = {
  LOSS: { row: "bg-danger-subtle/40", edge: "border-l-danger", bar: "shadow-[inset_3px_0_0_var(--color-danger)]", segment: "bg-danger", filter: "loss" },
  LOW_MARGIN: { row: "bg-warning-subtle/40", edge: "border-l-warning", bar: "shadow-[inset_3px_0_0_var(--color-warning)]", segment: "bg-warning", filter: "low" },
  GOOD: { row: "", edge: "border-l-transparent", bar: "", segment: "bg-success/50", filter: "profitable" },
  HIGH_MARGIN: { row: "", edge: "border-l-transparent", bar: "", segment: "bg-success", filter: "high" },
  REFUNDED: { row: "", edge: "border-l-border", bar: "shadow-[inset_3px_0_0_var(--color-border)]", segment: "bg-info/60", filter: "refunded" },
  MISSING_COST: { row: "", edge: "border-l-border", bar: "shadow-[inset_3px_0_0_var(--color-border)]", segment: "bg-muted-foreground/40", filter: "setup" },
  NEEDS_MAPPING: { row: "", edge: "border-l-border", bar: "shadow-[inset_3px_0_0_var(--color-border)]", segment: "bg-muted-foreground/20", filter: "setup" },
}
/** Healthy products stay quiet: only these groups get a sentence under their name. */
const NEEDS_WORDS = new Set<ProfitStatus>(["LOSS", "LOW_MARGIN", "MISSING_COST", "NEEDS_MAPPING"])
const HEALTH_ORDER: ProfitStatus[] = ["LOSS", "LOW_MARGIN", "GOOD", "HIGH_MARGIN", "REFUNDED", "MISSING_COST", "NEEDS_MAPPING"]

function profitTone(row: ProfitViewRow): string {
  if (row.grossProfit === null) return "text-muted-foreground"
  return compareMoney(row.grossProfit, "0") < 0 ? "text-danger-strong" : "text-success-strong"
}

function ProductTags({ row }: { row: ProfitViewRow }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {row.kind === "PRODUCT" && row.sku && <span className="font-mono">SKU {row.sku}</span>}
      {row.kind === "PRODUCT" && row.category && <span>{row.category}</span>}
      {row.kind === "UNMAPPED_SKU" && <span>SKU not matched</span>}
      {row.marketplace && (
        <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
          {row.marketplace}
        </span>
      )}
      {row.highSales && (
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
          <TrendingUp className="size-3" aria-hidden />
          High sales
        </span>
      )}
    </div>
  )
}

export function ProductTable({ rows, currency }: { rows: ProfitViewRow[]; currency: string }) {
  const [filter, setFilter] = useState<FilterKey>("all")
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<Sort>({ key: "netSales", direction: "desc" })
  const [page, setPage] = useState(0)

  const counts = useMemo(() => filterCounts(rows), [rows])
  const byStatus = useMemo(() => {
    const out = {} as Record<ProfitStatus, number>
    for (const status of HEALTH_ORDER) out[status] = rows.filter((row) => row.status === status).length
    return out
  }, [rows])
  const money = (value: string | null) => formatMoney(value, currency)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matching = rows.filter(
      (row) =>
        matchesFilter(row, filter) &&
        (needle === "" ||
          [row.name, row.sku, row.category, row.marketplace].some((text) => text?.toLowerCase().includes(needle)))
    )
    return [...matching].sort((a, b) => compareRows(a, b, sort))
  }, [rows, filter, query, sort])

  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const shown = visible.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)

  function choose(next: FilterKey) {
    setFilter(next)
    setPage(0)
  }

  function sortBy(key: SortKey) {
    setPage(0)
    setSort((previous) =>
      previous.key === key
        ? { key, direction: previous.direction === "desc" ? "asc" : "desc" }
        : { key, direction: key === "name" ? "asc" : "desc" }
    )
  }

  /** The tint that marks the sorted column, so the eye finds what it is ordered by. */
  const sorted = (key: SortKey) => (sort.key === key ? "bg-muted/50" : "")

  function header(key: SortKey, label: string, align: "left" | "right" = "right") {
    const active = sort.key === key
    const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
        className={`border-r border-border px-3 py-3 font-semibold ${align === "right" ? "text-right" : "text-left"} ${sorted(key)}`}
      >
        <button
          type="button"
          onClick={() => sortBy(key)}
          className={`inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground ${active ? "text-foreground" : ""}`}
        >
          {label}
          <Icon className="size-3" aria-hidden />
        </button>
      </th>
    )
  }

  return (
    <section id="all-products" className="scroll-mt-20 space-y-4">
      {/* Portfolio health: how the products split, and a way into each group. */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Portfolio health</h2>
          <p className="text-xs text-muted-foreground">
            {formatNumber(rows.length)} product{rows.length === 1 ? "" : "s"} and SKUs. Select a group to filter the list.
          </p>
        </div>
        <div className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full" role="group" aria-label="Products by group">
          {HEALTH_ORDER.filter((status) => byStatus[status] > 0).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => choose(LOOK[status].filter)}
              style={{ flexGrow: byStatus[status], flexBasis: 0, minWidth: "0.5rem" }}
              className={`${LOOK[status].segment} transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`}
              aria-label={`${STATUS_LABEL[status]}: ${byStatus[status]}`}
              title={`${STATUS_LABEL[status]}: ${byStatus[status]}`}
            />
          ))}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
          {HEALTH_ORDER.filter((status) => byStatus[status] > 0).map((status) => (
            <li key={status}>
              <button type="button" onClick={() => choose(LOOK[status].filter)} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
                <span className={`size-2.5 rounded-full ${LOOK[status].segment}`} aria-hidden />
                {STATUS_LABEL[status]}
                <span className="font-semibold text-foreground tabular-nums">{formatNumber(byStatus[status])}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter products">
          {/* The health bar's "Good" segment filters by "profitable", which has no chip: show it while it is active. */}
          {(FILTER_CHIPS.includes(filter) ? FILTER_CHIPS : [...FILTER_CHIPS, filter]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => choose(key)}
              className={
                filter === key
                  ? "rounded-full border border-primary bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground"
                  : "rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground"
              }
            >
              {FILTER_LABEL[key]} ({formatNumber(counts[key])})
            </button>
          ))}
        </div>

        <label className="relative block w-full lg:w-72">
          <span className="sr-only">Search by product name or SKU</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
            placeholder="Search by product name or SKU…"
            className="h-10 w-full rounded-xl border border-input bg-card pr-3 pl-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </label>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          <p>No products match.</p>
          {(filter !== "all" || query !== "") && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 rounded-4xl"
              onClick={() => {
                setFilter("all")
                setQuery("")
                setPage(0)
              }}
            >
              Clear filter and search
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* Wide screens: the full table. */}
          <p className="hidden text-right text-xs text-muted-foreground md:block 2xl:hidden">
            Marketplace costs, COGS, status and the action are to the right: scroll sideways.
          </p>
          <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[68rem] border-collapse text-sm">
                <thead className="border-b-2 border-border bg-muted/30 text-[11px] tracking-wide text-muted-foreground uppercase">
                  <tr>
                    {header("name", "Product", "left")}
                    {header("units", "Units")}
                    {header("netSales", "Net sales")}
                    {header("grossProfit", "Gross profit")}
                    {header("margin", "Margin")}
                    {header("costs", "Marketplace costs")}
                    {header("cogs", "COGS")}
                    <th scope="col" className="border-r border-border px-3 py-3 text-left font-semibold">Status</th>
                    <th scope="col" className="px-3 py-3 text-left font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map((row) => (
                    <tr key={row.key} className={`align-middle transition-colors ${LOOK[row.status].row} hover:bg-muted/50`}>
                      <td className={`border-r border-border px-3 py-3.5 ${LOOK[row.status].bar} ${sorted("name")}`}>
                        <div className="flex min-w-56 items-start gap-3">
                          <ProductThumb />
                          <div className="min-w-0">
                            {row.productId ? (
                              <Link href={`/catalog/products/${row.productId}`} className="font-semibold hover:underline">
                                {row.name}
                              </Link>
                            ) : (
                              <span className="font-mono text-xs font-semibold">{row.name}</span>
                            )}
                            <ProductTags row={row} />
                            {NEEDS_WORDS.has(row.status) && (
                              <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground">{row.recommendation}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className={`border-r border-border px-3 py-3.5 whitespace-nowrap text-right font-mono tabular-nums ${sorted("units")}`}>{formatNumber(row.units, 4)}</td>
                      <td className={`border-r border-border px-3 py-3.5 whitespace-nowrap text-right font-mono tabular-nums ${sorted("netSales")}`}>{money(row.netSales)}</td>
                      <td className={`border-r border-border px-3 py-3.5 whitespace-nowrap text-right font-mono text-[15px] font-bold tabular-nums ${profitTone(row)} ${sorted("grossProfit")}`}>
                        {row.grossProfit === null ? <span className="text-sm font-medium">Incomplete</span> : money(row.grossProfit)}
                      </td>
                      <td className={`border-r border-border px-3 py-3.5 text-right ${sorted("margin")}`}>
                        <MarginChip margin={row.margin} status={row.status} />
                      </td>
                      <td className={`border-r border-border px-3 py-3.5 whitespace-nowrap text-right font-mono text-muted-foreground tabular-nums ${sorted("costs")}`}>{money(row.costs)}</td>
                      <td className={`border-r border-border px-3 py-3.5 whitespace-nowrap text-right font-mono tabular-nums ${sorted("cogs")}`}>
                        {row.cogs === null ? <span className="text-muted-foreground">Incomplete</span> : money(row.cogs)}
                      </td>
                      <td className="border-r border-border px-3 py-3.5">
                        <StatusPill status={row.status} />
                      </td>
                      <td className="px-3 py-3.5">
                        <Button asChild size="sm" variant="outline" className="rounded-4xl whitespace-nowrap">
                          <Link href={row.action.href}>{row.action.label}</Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Phones: one card per product, the figures that matter first. */}
          <ul className="space-y-3 md:hidden">
            {shown.map((row) => (
              <li
                key={row.key}
                className={`rounded-xl border border-l-4 border-border bg-card p-4 ${LOOK[row.status].edge} ${LOOK[row.status].row}`}
              >
                <div className="flex items-start gap-3">
                  <ProductThumb />
                  <div className="min-w-0 flex-1">
                    <p className={row.kind === "UNMAPPED_SKU" ? "font-mono text-xs font-semibold" : "font-semibold"}>{row.name}</p>
                    <ProductTags row={row} />
                  </div>
                  <StatusPill status={row.status} />
                </div>

                <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Net sales</dt>
                    <dd className="font-mono tabular-nums">{money(row.netSales)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Gross profit</dt>
                    <dd className={`font-mono font-bold tabular-nums ${profitTone(row)}`}>
                      {row.grossProfit === null ? "Incomplete" : money(row.grossProfit)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Margin</dt>
                    <dd>
                      <MarginChip margin={row.margin} status={row.status} />
                    </dd>
                  </div>
                </dl>

                {NEEDS_WORDS.has(row.status) && <p className="mt-3 text-xs text-muted-foreground">{row.recommendation}</p>}
                <Button asChild size="sm" variant="outline" className="mt-3 rounded-4xl">
                  <Link href={row.action.href}>{row.action.label}</Link>
                </Button>
              </li>
            ))}
          </ul>

          <nav className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground" aria-label="Pages">
            <p>
              Showing {formatNumber(current * PAGE_SIZE + 1)}–{formatNumber(current * PAGE_SIZE + shown.length)} of{" "}
              {formatNumber(visible.length)}
            </p>
            {pages > 1 && (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="rounded-4xl" disabled={current === 0} onClick={() => setPage(current - 1)}>
                  <ChevronLeft className="size-4" aria-hidden />
                  Previous
                </Button>
                <span className="tabular-nums">
                  Page {current + 1} of {pages}
                </span>
                <Button variant="outline" size="sm" className="rounded-4xl" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                  Next
                  <ChevronRight className="size-4" aria-hidden />
                </Button>
              </div>
            )}
          </nav>
        </>
      )}
    </section>
  )
}
