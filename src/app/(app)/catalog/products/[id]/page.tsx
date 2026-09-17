import type { Metadata } from "next"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { z } from "zod"

import { AppShell } from "@/components/layout/app-shell"
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
import { ProductCostForm } from "@/features/catalog/components/product-cost-form"
import { ProductForm } from "@/features/catalog/components/product-form"
import { RowActionButton } from "@/features/catalog/components/row-action-button"
import { getProductDetail, listBusinessCurrencies } from "@/features/catalog/queries"
import { formatMoney } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { formatLedgerDay } from "@/services/ledger/display"

export const metadata: Metadata = {
  title: "Product",
}

/**
 * One product: its details, its dated costs (never edited -- a wrong cost is
 * withdrawn and a new one added) and the marketplace SKUs matched to it.
 */
export default async function ProductPage(props: PageProps<"/catalog/products/[id]">) {
  const { id } = await props.params
  if (!z.string().uuid().safeParse(id).success) notFound()

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, detail, currencies] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getProductDetail(activeBusiness.id, id),
    listBusinessCurrencies(activeBusiness.id),
  ])
  if (!detail) notFound()

  const { product, costs, skus } = detail
  const canManage = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"
  const confirmed = skus.filter((s) => s.status === "CONFIRMED")
  const rejected = skus.filter((s) => s.status === "REJECTED")

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-5xl gap-6">
        <div>
          <Link href="/catalog" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden />
            Products and costs
          </Link>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">{product.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[product.sku_code, product.category, product.brand].filter(Boolean).join(" · ") || "No SKU code, category or brand"}
            {product.status === "ARCHIVED" && " · Archived"}
          </p>
        </div>

        {/* ---- costs ------------------------------------------------------- */}
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">Cost history</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Each sale uses the latest cost that started on or before its date, in its currency.
            </p>
          </div>
          {costs.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No cost yet: sales of this product keep gross profit incomplete.
            </p>
          ) : (
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Applies from</TableHead>
                    <TableHead className="text-right">Cost per unit</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Status</TableHead>
                    {canManage && <TableHead className="text-right">Action</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {costs.map((c) => (
                    <TableRow key={c.id} className={c.retired_at ? "text-muted-foreground" : undefined}>
                      <TableCell className="text-sm">{formatLedgerDay(c.effective_from)}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">
                        {c.retired_at ? <s>{formatMoney(c.unit_cost, c.currency)}</s> : formatMoney(c.unit_cost, c.currency)}
                      </TableCell>
                      <TableCell className="text-xs">{c.note ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {c.retired_at
                          ? `Withdrawn ${formatLedgerDay(c.retired_at)}${c.retire_reason ? `: ${c.retire_reason}` : ""}`
                          : "In use"}
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          {!c.retired_at && <RowActionButton kind="retire-cost" id={c.id} />}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {canManage && <ProductCostForm productId={product.id} currencies={currencies} />}

        {/* ---- SKUs -------------------------------------------------------- */}
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">Marketplace SKUs</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Sales under these SKUs count as this product.{" "}
              <Link href="/catalog/mapping" className="font-medium text-foreground underline underline-offset-4">
                Match more SKUs
              </Link>
            </p>
          </div>
          {skus.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">No SKUs matched yet.</p>
          ) : (
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Marketplace</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Decision</TableHead>
                    {canManage && <TableHead className="text-right">Action</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...confirmed, ...rejected].map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-sm">{s.marketplace_code}</TableCell>
                      <TableCell className="font-mono text-xs">{s.raw_sku}</TableCell>
                      <TableCell className="text-xs">
                        {s.status === "CONFIRMED" ? "Matched" : "Not this product"} · {formatLedgerDay(s.decided_at)}
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          <RowActionButton kind="remove-match" id={s.id} />
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {canManage && <ProductForm product={product} />}
      </div>
    </AppShell>
  )
}
