import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { CircleAlert } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { getProductProfit, type ProductProfitRow } from "@/features/catalog/queries"
import { LedgerFilters } from "@/features/ledger/components/ledger-filters"
import { firstParam } from "@/features/ledger/params"
import {
  getCurrencyMonth,
  getLedgerMonth,
  getLedgerPeriods,
  listLedgerAccounts,
  type LedgerAccount,
} from "@/features/ledger/queries"
import { formatMoney, formatNumber, formatPercent } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import type { PnlSummaryRow } from "@/services/ledger/export"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"

export const metadata: Metadata = {
  title: "Product profit",
}

/**
 * Product profit (GCC Phase 6).
 *
 * PERFORMS NO CALCULATIONS: pnl_by_product() works out every row in SQL.
 * A product's figures include only the lines the marketplace attributed to
 * one of its order lines. Marketplace-level fees and advertising are never
 * spread across products (A7); they stay in their own row, so all rows
 * together equal the account's contribution less COGS.
 */

const ALL_PREFIX = "all-"

const COGS_NOTE: Record<ProductProfitRow["cogs_status"], string> = {
  COSTED: "",
  PARTLY_COSTED: "Some sales have no cost for their date",
  NO_COST: "No cost for these sales' dates",
  NO_PRODUCT: "SKU not matched to a product",
  NOT_APPLICABLE: "",
}

export default async function ProductProfitPage(props: PageProps<"/ledger/products">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, accounts, periods] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listLedgerAccounts(activeBusiness.id),
    getLedgerPeriods(activeBusiness.id),
  ])

  const byCurrency = new Map<string, LedgerAccount[]>()
  for (const a of accounts) byCurrency.set(a.currency, [...(byCurrency.get(a.currency) ?? []), a])
  const currencyGroups = [...byCurrency.entries()].filter(([, list]) => list.length > 1)

  const requested = firstParam(searchParams.account)
  const requestedCurrency = requested?.startsWith(ALL_PREFIX) ? requested.slice(ALL_PREFIX.length) : null
  const combined = currencyGroups.find(([currency]) => currency === requestedCurrency)?.[0] ?? null
  const account = combined
    ? null
    : (accounts.find((a) => a.id === requested) ??
      accounts.find((a) => periods.some((p) => p.marketplace_account_id === a.id)) ??
      accounts[0] ??
      null)

  const inScope = new Set(
    combined ? (byCurrency.get(combined) ?? []).map((a) => a.id) : account ? [account.id] : []
  )
  const monthKeys = [...new Set(periods.filter((p) => inScope.has(p.marketplace_account_id)).map((p) => monthKeyOf(p.month)))]
    .sort()
    .reverse()
  const monthOptions = monthKeys.map((key) => parseLedgerMonth(key)).filter((m): m is LedgerMonth => m !== null)
  const month = parseLedgerMonth(firstParam(searchParams.month)) ?? monthOptions[0] ?? null
  if (month && !monthOptions.some((m) => m.key === month.key)) monthOptions.unshift(month)

  let rows: ProductProfitRow[] = []
  let summary: PnlSummaryRow | null = null
  if (month && combined) {
    const [profit, group] = await Promise.all([
      getProductProfit(activeBusiness.id, { currency: combined }, month),
      getCurrencyMonth(activeBusiness.id, combined, month),
    ])
    rows = profit
    summary = group.total
  } else if (month && account) {
    const [profit, single] = await Promise.all([
      getProductProfit(activeBusiness.id, { accountId: account.id }, month),
      getLedgerMonth(activeBusiness.id, account.id, month),
    ])
    rows = profit
    summary = single.summary
  }

  const filterOptions = [
    ...accounts.map((a) => ({ id: a.id, label: a.label, detail: `${a.marketplace_code} · ${a.currency}` })),
    ...currencyGroups.map(([currency, list]) => ({
      id: `${ALL_PREFIX}${currency}`,
      label: `All ${currency} accounts`,
      detail: `${list.length} accounts, added up`,
    })),
  ]
  const currency = summary?.currency ?? combined ?? account?.currency ?? ""
  const money = (value: string | null | undefined) => formatMoney(value, currency)

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-6xl gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Product profit</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            What each product made after the marketplace costs charged on its orders and its cost of
            goods. Fees and advertising the marketplace charges for the whole account stay in their
            own row and are never spread across products.
          </p>
        </div>

        {accounts.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Add a marketplace account and upload its reports first.
          </p>
        ) : (
          <>
            <LedgerFilters
              basePath="/ledger/products"
              accounts={filterOptions}
              months={monthOptions.map((m) => ({ key: m.key, label: m.label }))}
              accountId={combined ? `${ALL_PREFIX}${combined}` : (account?.id ?? "")}
              monthKey={month?.key ?? null}
            />

            {summary && summary.gross_profit === null && (
              <section role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-subtle px-5 py-3 text-sm">
                <CircleAlert className="size-4 shrink-0 text-warning-strong" aria-hidden />
                <p className="min-w-0 flex-1">
                  Gross profit for {month?.label} is not final.{" "}
                  {[
                    summary.gross_profit_reasons.includes("SKU_NOT_MAPPED") && "Some SKUs are not matched to a product.",
                    summary.gross_profit_reasons.includes("COST_MISSING") && "Some products have no cost for the sale date.",
                    summary.contribution === null && "Contribution itself is still incomplete (see Marketplace profit).",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                </p>
                <Button asChild size="sm" variant="outline" className="rounded-4xl">
                  <Link href="/catalog/mapping">Match SKUs</Link>
                </Button>
              </section>
            )}

            {!month || rows.length === 0 ? (
              <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                No profit lines for this choice.
              </p>
            ) : (
              <section className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold">{month.label}, by product</h2>
                  {summary && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      All rows together: contribution {money(summary.contribution_before_open_items)}, cost of goods{" "}
                      {money(summary.cogs)}
                      {summary.gross_profit === null ? " (not final)" : `, gross profit ${money(summary.gross_profit)}`}.
                    </p>
                  )}
                </div>
                <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Units</TableHead>
                        <TableHead className="text-right">Net sales</TableHead>
                        <TableHead className="text-right">Marketplace costs</TableHead>
                        <TableHead className="text-right">Contribution</TableHead>
                        <TableHead className="text-right">Cost of goods</TableHead>
                        <TableHead className="text-right">Gross profit</TableHead>
                        <TableHead className="text-right">Margin</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow
                          key={`${row.row_kind}-${row.product_id ?? ""}-${row.marketplace_code ?? ""}-${row.raw_sku ?? ""}`}
                          className={row.row_kind === "NOT_ALLOCATED" ? "bg-muted/40" : undefined}
                        >
                          <TableCell className="text-sm">
                            {row.row_kind === "PRODUCT" && row.product_id ? (
                              <Link href={`/catalog/products/${row.product_id}`} className="font-medium underline-offset-4 hover:underline">
                                {row.product_name}
                              </Link>
                            ) : row.row_kind === "UNMAPPED_SKU" ? (
                              <Link href="/catalog/mapping" className="underline-offset-4 hover:underline">
                                <span className="font-mono text-xs">{row.raw_sku}</span>
                                <span className="ml-1 text-[11px] text-muted-foreground">{row.marketplace_code}</span>
                              </Link>
                            ) : (
                              <span className="font-medium">Not allocated to a product (order- and account-level lines)</span>
                            )}
                            {COGS_NOTE[row.cogs_status] && (
                              <span className="flex items-center gap-1 text-[11px] text-warning-strong">
                                <CircleAlert className="size-3" aria-hidden />
                                {COGS_NOTE[row.cogs_status]}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {row.row_kind === "NOT_ALLOCATED" ? "—" : formatNumber(row.units_sold, 4)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">{money(row.net_sales)}</TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">{money(row.costs)}</TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">{money(row.contribution)}</TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {row.row_kind === "NOT_ALLOCATED" ? "—" : row.cogs === null ? "Incomplete" : money(row.cogs)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm font-semibold tabular-nums">
                            {row.row_kind === "NOT_ALLOCATED"
                              ? money(row.contribution)
                              : row.gross_profit === null
                                ? "Incomplete"
                                : money(row.gross_profit)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {row.gross_margin_percent === null ? "—" : formatPercent(row.gross_margin_percent)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}
