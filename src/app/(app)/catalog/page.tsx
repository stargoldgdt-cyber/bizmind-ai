import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowRight, CircleAlert } from "lucide-react"

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
import { ProductForm } from "@/features/catalog/components/product-form"
import { getSkuQueue, listProductOverview } from "@/features/catalog/queries"
import { formatMoney, formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { formatLedgerDay } from "@/services/ledger/display"

export const metadata: Metadata = {
  title: "Products and costs",
}

/**
 * Products and costs (GCC Phase 6): the product master with each product's
 * cost in force today. Gross profit uses the cost in force on each sale's
 * date, so this list is a convenience, not the figure.
 */
export default async function CatalogPage() {
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, products, queue] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listProductOverview(activeBusiness.id),
    getSkuQueue(activeBusiness.id),
  ])
  const canManage = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-6xl gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Products and costs</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            Your own products, what each unit costs, and which marketplace SKUs they sell under.
            Gross profit is worked out from these.
          </p>
        </div>

        {queue.length > 0 && (
          <section role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-subtle px-5 py-3 text-sm">
            <CircleAlert className="size-4 shrink-0 text-warning-strong" aria-hidden />
            <p className="min-w-0 flex-1">
              {formatNumber(queue.length)} marketplace SKU{queue.length === 1 ? " is" : "s are"} not matched to a
              product yet, so gross profit cannot be final for the months they sold in.
            </p>
            <Button asChild size="sm" variant="outline" className="rounded-4xl">
              <Link href="/catalog/mapping">
                Match SKUs
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
          </section>
        )}

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">Your products</h2>
          </div>
          {products.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No products yet. Add one below, or create them straight from your marketplace SKUs on{" "}
              <Link href="/catalog/mapping" className="font-medium text-foreground underline underline-offset-4">
                SKU matching
              </Link>
              .
            </p>
          ) : (
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Your SKU code</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Marketplace SKUs</TableHead>
                    <TableHead className="text-right">Cost today</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.map((p) => (
                    <TableRow key={p.product_id}>
                      <TableCell className="text-sm">
                        <Link href={`/catalog/products/${p.product_id}`} className="font-medium underline-offset-4 hover:underline">
                          {p.name}
                        </Link>
                        {p.status === "ARCHIVED" && (
                          <span className="ml-2 text-[11px] text-muted-foreground">Archived</span>
                        )}
                        {p.brand && <span className="block text-[11px] text-muted-foreground">{p.brand}</span>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{p.sku_code ?? "—"}</TableCell>
                      <TableCell className="text-sm">{p.category ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{formatNumber(p.mapped_skus)}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">
                        {p.current_costs.length === 0 ? (
                          <span className="inline-flex items-center gap-1 font-sans text-xs text-warning-strong">
                            <CircleAlert className="size-3.5" aria-hidden />
                            No cost
                          </span>
                        ) : (
                          p.current_costs.map((c) => (
                            <span key={c.currency} className="block">
                              {formatMoney(c.unit_cost, c.currency)}
                              <span className="ml-1 font-sans text-[11px] text-muted-foreground">
                                since {formatLedgerDay(c.effective_from)}
                              </span>
                            </span>
                          ))
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {canManage ? (
          <ProductForm />
        ) : (
          <p className="text-sm text-muted-foreground">Only an owner or admin can add products and costs.</p>
        )}
      </div>
    </AppShell>
  )
}
