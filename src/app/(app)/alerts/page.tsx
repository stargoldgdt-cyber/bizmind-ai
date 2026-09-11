import type { Metadata } from "next"
import { redirect } from "next/navigation"
import Link from "next/link"
import { BellOff } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { AlertCard } from "@/features/automation/components/alert-card"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { listAlerts, listRules, presentAlert } from "@/services/automation"

export const metadata: Metadata = { title: "Alerts" }

/**
 * Alerts.
 *
 * ONE JOB: what needs attention, and what has been dealt with.
 *
 * The rules that produce these live on /automations, and the record of every
 * check — including the ones that raised nothing, and why — lives on
 * /activity. They are separated because they are read at different moments:
 * alerts when something has happened, rules when deciding what should count
 * as something happening, activity when asking why nobody was told.
 *
 * Everything here is read through the automation service, which runs as the
 * signed-in user, so RLS decides what is visible.
 */
export default async function AlertsPage() {
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

  const [alerts, rules] = await Promise.all([
    listAlerts(activeBusiness.id, { limit: 50 }),
    listRules(activeBusiness.id),
  ])

  const open = alerts.filter((alert) => alert.status === "OPEN")
  const seen = alerts.filter((alert) => alert.status !== "OPEN")
  const currency = activeBusiness.currency

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-5xl">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Alerts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            BizMind checks your figures on a schedule and tells you when one
            crosses a line you set. It never acts on your business itself.
          </p>
        </header>

        <section className="mt-8" aria-label="Alerts needing attention">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-heading text-lg font-semibold">
              Needs your attention
            </h2>
            {open.length > 0 && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {open.length} open
              </p>
            )}
          </div>

          {open.length === 0 ? (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-border bg-card px-5 py-6">
              <BellOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <p className="text-sm font-medium">Nothing needs attention</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {rules.length === 0
                    ? "You have no rules yet, so nothing is being watched."
                    : "Your rules were checked and none of them crossed their limit."}
                </p>
              </div>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {open.map((alert) => (
                <AlertCard key={alert.id} presented={presentAlert(alert, currency)} />
              ))}
            </ul>
          )}
        </section>

        {seen.length > 0 && (
          <section className="mt-10" aria-label="Alerts already seen">
            <h2 className="font-heading text-lg font-semibold">Already seen</h2>
            <ul className="mt-4 space-y-3">
              {seen.map((alert) => (
                <AlertCard key={alert.id} presented={presentAlert(alert, currency)} />
              ))}
            </ul>
          </section>
        )}

        <section className="mt-12" aria-label="Rules">
          <div className="rounded-xl border border-border bg-card px-5 py-4">
            <h2 className="text-sm font-semibold">
              {rules.length === 0
                ? "Nothing is being watched yet"
                : `${rules.length} rule${rules.length === 1 ? "" : "s"} are watching your figures`}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {rules.length === 0
                ? "Add a rule and BizMind will check it on a schedule, then tell you when a figure crosses the line you set."
                : "Each one is checked on its own schedule. See what they have been doing, or change what they watch."}
            </p>
            <Button asChild size="sm" variant="outline" className="mt-4 rounded-4xl">
              <Link href="/automations">
                {rules.length === 0 ? "Set up a rule" : "Manage rules"}
              </Link>
            </Button>
          </div>
        </section>
      </div>
    </AppShell>
  )
}
