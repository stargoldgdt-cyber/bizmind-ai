import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { Building2, ShieldCheck, Users } from "lucide-react"

import { Logo } from "@/components/brand/logo"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { signOutAction } from "@/features/auth/actions"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { getCurrentUser } from "@/lib/supabase/server"

export const metadata: Metadata = {
  title: "Dashboard",
}

/**
 * Placeholder dashboard.
 *
 * This is NOT the real dashboard — that is Phase 4. It exists to prove the
 * Phase 2 chain end to end: a session survives a page load, the tenancy tables
 * are readable under RLS, and the active business resolves correctly.
 */
export default async function DashboardPage() {
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  // A signed-in user with no business has nothing to look at yet.
  if (!activeBusiness) {
    redirect(ONBOARDING_ROUTE)
  }

  return (
    <div className="min-h-dvh bg-surface-2 text-surface-2-foreground">
      <header className="border-b border-surface-1-border bg-surface-1">
        <div className="mx-auto flex h-16 max-w-marketing items-center justify-between px-5 sm:px-8">
          <Logo />
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {user?.email}
            </span>
            <form action={signOutAction}>
              <Button type="submit" variant="outline" size="sm" className="rounded-4xl">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-marketing px-5 py-10 sm:px-8">
        <p className="text-xs font-semibold tracking-widest text-primary uppercase">
          Phase 2 — Authentication and tenancy
        </p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
          {activeBusiness.name}
        </h1>
        <p className="mt-3 max-w-prose-comfortable text-surface-2-muted">
          Your account and workspace are live and isolated. The dashboard itself
          arrives in Phase 4, once there is real data to show.
        </p>

        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="shadow-none">
            <CardHeader>
              <div className="flex size-10 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <Building2 className="size-5" aria-hidden />
              </div>
              <CardTitle className="mt-3">Business</CardTitle>
              <CardDescription>The workspace your data connects to.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Name" value={activeBusiness.name} />
              <Row label="Reference" value={activeBusiness.slug} mono />
              <Row label="Currency" value={activeBusiness.currency} mono />
            </CardContent>
          </Card>

          <Card className="shadow-none">
            <CardHeader>
              <div className="flex size-10 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <Users className="size-5" aria-hidden />
              </div>
              <CardTitle className="mt-3">Your access</CardTitle>
              <CardDescription>What you are allowed to do here.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Role</span>
                <Badge>{activeBusiness.role}</Badge>
              </div>
              <Row
                label="Businesses"
                value={String(businesses.length)}
                mono
              />
            </CardContent>
          </Card>

          <Card className="shadow-none">
            <CardHeader>
              <div className="flex size-10 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <ShieldCheck className="size-5" aria-hidden />
              </div>
              <CardTitle className="mt-3">Isolation</CardTitle>
              <CardDescription>Enforced by the database, not the app.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Row Level Security is active on every table. Another business
              cannot read this data even if application code asked it to.
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs tabular-nums" : undefined}>{value}</span>
    </div>
  )
}
