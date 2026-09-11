import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { ProductTable } from "@/features/analytics/components/product-table"
import { RangeSelector } from "@/features/analytics/components/range-selector"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { formatMoney } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import {
  DEFAULT_PERIOD,
  getAnalytics,
  isPeriodKey,
  resolvePeriod,
} from "@/services/analytics"

export const metadata: Metadata = { title: "Products" }

/**
 * Product profitability.
 *
 * Reuses `ProductTable` — the same component the dashboard renders — fed by
 * the same `analytics_products()` function. There is no second definition of
 * product revenue or product margin anywhere in the product.
 *
 * THE ALLOCATION CAVEAT IS STATED, NOT BURIED.
 *
 * Line revenue excludes shipping and order-level discounts, and fees are
 * shared across lines in proportion to value — an allocation, not a charge
 * anyone actually paid per product. So this table will not reconcile exactly
 * to total revenue, and the gap is shown with its size rather than left for
 * an owner to discover when their accountant asks.
 *
 * Stock is not shown. The universal model carries an inventory figure, but
 * nothing yet keeps it current per product, and a stale stock number on a
 * profitability screen is worse than no stock number.
 */
export default async function ProductsPage(props: PageProps<"/products">) {
  const searchParams = await props.searchParams
  const rangeParam = Array.isArray(searchParams.range)
    ? searchParams.range[0]
    : searchParams.range
  const period = resolvePeriod(isPeriodKey(rangeParam) ? rangeParam : DEFAULT_PERIOD)

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user!.id)
    .maybeSingle()

  const analytics = await getAnalytics(activeBusiness.id, period, activeBusiness.currency)
  const { products, reconciliation, current } = analytics
  const currency = activeBusiness.currency

  const missingCostLines = current.items_total - current.items_with_cost

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Products</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {period.label} · figures in {currency}
            </p>
          </div>
          <RangeSelector active={period.key} basePath="/products" />
        </div>

        {analytics.error ? (
          <div
            role="alert"
            className="mt-6 rounded-xl border border-danger/25 bg-danger-subtle px-5 py-6"
          >
            <p className="text-sm font-medium text-danger-strong">
              We couldn&apos;t work out product profitability.
            </p>
            <p className="mt-1 text-sm text-danger-strong/85">
              Your records are unaffected. Try again in a moment.
            </p>
          </div>
        ) : products.length === 0 ? (
          <div className="mt-6 rounded-xl border border-border bg-card px-6 py-12 text-center">
            <p className="font-medium">No products sold in this period</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
              Product figures come from the individual lines on your orders. If
              your import had order totals but no line items, there is nothing
              to break down here.
            </p>
            <div className="mt-5 flex flex-col items-center justify-center gap-2 sm:flex-row">
              <Button asChild variant="outline" className="rounded-4xl">
                <Link href="/products?range=365d">Look at the last 12 months</Link>
              </Button>
              <Button asChild variant="ghost" className="rounded-4xl">
                <Link href="/imports/new">Import data</Link>
              </Button>
            </div>
          </div>
        ) : (
          <>
            {missingCostLines > 0 && (
              <div className="mt-6 rounded-xl border border-warning/30 bg-warning-subtle px-5 py-4">
                <p className="text-sm font-medium text-warning-strong">
                  {missingCostLines} of {current.items_total} lines have no cost
                  recorded
                </p>
                <p className="mt-1 text-sm text-warning-strong/85">
                  Those products show no margin rather than a made-up one, and
                  every margin below is higher than reality until the costs are
                  filled in.
                </p>
              </div>
            )}

            <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
              <ProductTable products={products} currency={currency} />
            </div>

            <div className="mt-4 space-y-1 text-xs text-muted-foreground">
              <p>
                Revenue here is order-line revenue, so it excludes shipping and
                order-level discounts. Fees are shared across lines in
                proportion to their value — an allocation, not a charge you paid
                per product.
              </p>
              {Number(reconciliation.order_line_gap) !== 0 && (
                <p>
                  For this period, order revenue exceeds the sum of product
                  lines by{" "}
                  <span className="font-medium">
                    {formatMoney(reconciliation.order_line_gap, currency)}
                  </span>
                  . That difference is shipping, order-level discounts, and any
                  orders recorded without product lines.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
