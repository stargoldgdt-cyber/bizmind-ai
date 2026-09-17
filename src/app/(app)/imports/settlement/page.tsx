import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { SettlementUploader } from "@/features/imports/components/settlement-uploader"
import { listMarketplaceAccounts } from "@/features/marketplaces/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"

export const metadata: Metadata = {
  title: "Upload a settlement",
}

/**
 * Uploading a marketplace settlement file into the ledger.
 *
 * Only accounts on a marketplace whose files BizMind can read are offered.
 */
export default async function SettlementUploadPage() {
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, accounts] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listMarketplaceAccounts(),
  ])

  const uploadable = accounts.filter(
    (account) => account.status === "ACTIVE" && account.adapter_status === "AVAILABLE"
  )
  const canImport = activeBusiness.role !== "VIEWER"

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-4xl">
        <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 rounded-4xl">
          <Link href="/imports">
            <ArrowLeft className="size-4" aria-hidden />
            All data sources
          </Link>
        </Button>

        <h1 className="text-2xl font-bold tracking-tight">Upload a settlement</h1>
        <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
          BizMind reads every line of the marketplace&apos;s own settlement report
          and records it as it was reported: sales, fees, refunds, advertising and
          the payout. Customer details are never stored.
        </p>

        <div className="mt-6">
          {!canImport ? (
            <p className="rounded-xl border border-border bg-card p-6 text-sm">
              Your role in {activeBusiness.name} can view data but not import it.
            </p>
          ) : uploadable.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-6 text-sm">
              <p className="font-medium">No account to upload into yet</p>
              <p className="mt-1 text-muted-foreground">
                Settlement files are recorded against a marketplace account. Amazon
                and noon files can be uploaded today.
              </p>
              <Button asChild size="sm" variant="outline" className="mt-4 rounded-4xl">
                <Link href="/marketplaces">Marketplace accounts</Link>
              </Button>
            </div>
          ) : (
            <SettlementUploader
              accounts={uploadable.map((account) => ({
                id: account.id,
                label: account.label,
                marketplace: account.marketplace_name,
                currency: account.currency,
              }))}
            />
          )}
        </div>
      </div>
    </AppShell>
  )
}
