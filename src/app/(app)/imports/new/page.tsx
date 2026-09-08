import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { ImportWizard } from "@/features/imports/components/import-wizard"
import { createClient, getCurrentUser } from "@/lib/supabase/server"

export const metadata: Metadata = {
  title: "Import data",
}

export default async function NewImportPage() {
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

  const canImport = activeBusiness.role !== "VIEWER"

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-5xl">
        <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 rounded-4xl">
          <Link href="/imports">
            <ArrowLeft className="size-4" aria-hidden />
            Import history
          </Link>
        </Button>

        <h1 className="text-2xl font-bold tracking-tight">Import your data</h1>
        <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
          Bring in sales, products or expenses from a spreadsheet. You will see
          exactly what will be saved before anything is written.
        </p>

        <div className="mt-6">
          {canImport ? (
            <ImportWizard businessCurrency={activeBusiness.currency} />
          ) : (
            <div className="rounded-xl border border-border bg-card p-6 text-sm">
              Your role in {activeBusiness.name} can view data but not import it.
              Ask an owner or admin to change your role.
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
