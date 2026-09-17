import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { CircleCheck } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { SkuMatchControls } from "@/features/catalog/components/sku-match-controls"
import { getSkuQueue, listActiveProducts } from "@/features/catalog/queries"
import { formatMoney, formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { formatLedgerDay } from "@/services/ledger/display"

export const metadata: Metadata = {
  title: "SKU matching",
}

/**
 * SKU matching (GCC Phase 6): every marketplace SKU in the business's files
 * that is not matched to a product, largest sales first, with suggestions.
 * Nothing is matched automatically (A10); a match applies to every period.
 */
export default async function SkuMappingPage() {
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, queue, products] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getSkuQueue(activeBusiness.id),
    listActiveProducts(activeBusiness.id),
  ])
  const canManage = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-5xl gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SKU matching</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            Marketplaces name the same product differently. Match each SKU to one of your products
            once, and its sales get a cost in every month. BizMind suggests matches but never makes
            one on its own.
          </p>
        </div>

        {queue.length === 0 ? (
          <section className="flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-6 text-sm">
            <CircleCheck className="size-4 text-success-strong" aria-hidden />
            <p>
              Every SKU in your marketplace files is matched to a product.{" "}
              <Link href="/catalog" className="font-medium underline underline-offset-4">
                Check their costs
              </Link>
            </p>
          </section>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {formatNumber(queue.length)} SKU{queue.length === 1 ? "" : "s"} to match, largest sales first.
              {!canManage && " Only an owner or admin can confirm matches."}
            </p>
            <ul className="grid gap-3">
              {queue.map((row) => (
                <li
                  key={`${row.marketplace_code}-${row.raw_sku}`}
                  className="grid gap-4 rounded-xl border border-border bg-card p-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      {row.marketplace_code} · {row.accounts}
                    </p>
                    <p className="mt-1 break-all font-mono text-sm font-semibold">{row.raw_sku}</p>
                    {row.sample_title && <p className="mt-1 text-sm">{row.sample_title}</p>}
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Units sold</dt>
                        <dd className="font-mono tabular-nums">{formatNumber(row.units_sold, 4)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Net sales</dt>
                        <dd className="font-mono tabular-nums">
                          {row.currencies.includes(",") ? "Several currencies" : formatMoney(row.net_sales, row.currencies)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Seen</dt>
                        <dd>
                          {formatLedgerDay(row.first_seen)} – {formatLedgerDay(row.last_seen)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  {canManage ? (
                    <SkuMatchControls
                      marketplaceCode={row.marketplace_code}
                      rawSku={row.raw_sku}
                      suggestedName={(row.sample_title ?? row.raw_sku).slice(0, 200)}
                      suggestions={row.suggestions}
                      products={products}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {row.suggestions.length > 0
                        ? `Suggested: ${row.suggestions.map((s) => s.name).join(", ")}`
                        : "No suggestion."}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </AppShell>
  )
}
