import type { Metadata } from "next"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { z } from "zod"

import { AppShell } from "@/components/layout/app-shell"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { ProductDetailSections } from "@/features/catalog/components/product-detail-sections"
import { getProductDetail, listBusinessCurrencies } from "@/features/catalog/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"

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

  const { product } = detail
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

        <ProductDetailSections detail={detail} currencies={currencies} canManage={canManage} />
      </div>
    </AppShell>
  )
}
