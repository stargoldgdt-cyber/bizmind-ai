import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { CircleAlert, Plug } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ONBOARDING_ROUTE } from "@/config/routes"
import {
  listConnections,
  recentWebhookEvents,
  webhookHealth,
} from "@/features/integrations/queries"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"

export const metadata: Metadata = { title: "Integrations" }

/**
 * Integrations.
 *
 * Deliberately small. The engine beneath it is the work; this page exists so
 * an owner can see that a store is connected, when it last synced, and whether
 * anything is wrong — which is the whole of what they need before a real
 * connector exists to configure.
 */
export default async function IntegrationsPage() {
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

  const [connections, health, events] = await Promise.all([
    listConnections(),
    webhookHealth(),
    recentWebhookEvents(10),
  ])

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-7xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connected stores, when they last synced, and anything that needs
            attention.
          </p>
        </div>

        {connections.length === 0 ? (
          <Card className="mt-6 shadow-none">
            <CardContent className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <span className="flex size-11 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <Plug className="size-5" aria-hidden />
              </span>
              <p className="font-heading text-lg font-semibold">No stores connected</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Shopify and WooCommerce connectors are not built yet. The engine
                that will run them is, and it is tested.
              </p>
            </CardContent>
          </Card>
        ) : (
          <section className="mt-6 space-y-4" aria-label="Connections">
            {connections.map((connection) => (
              <Card key={connection.accountId} className="shadow-none">
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">
                      {connection.displayName ?? connection.externalAccountId}
                    </CardTitle>
                    <Badge variant="outline">{connection.provider}</Badge>
                    <Badge
                      variant="outline"
                      className={
                        connection.status === "ERROR" ? "text-danger-strong" : undefined
                      }
                    >
                      {connection.status}
                    </Badge>
                  </div>
                  <CardDescription>
                    {connection.lastSuccessfulSyncAt
                      ? `Last successful sync ${new Date(connection.lastSuccessfulSyncAt).toLocaleString()}`
                      : "Has never completed a sync"}
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-3">
                  {connection.lastError && (
                    <p
                      role="alert"
                      className="flex items-start gap-2 text-sm text-danger-strong"
                    >
                      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span>{connection.lastError}</span>
                    </p>
                  )}

                  {connection.jobs.length > 0 && (
                    <ul className="space-y-1.5">
                      {connection.jobs.map((job) => (
                        <li
                          key={job.resource}
                          className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                        >
                          <span className="font-medium">{job.resource}</span>
                          <Badge variant="outline">{job.status}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {job.mode.toLowerCase()}
                            {job.attempts > 0 && ` · attempt ${job.attempts}`}
                          </span>
                          {job.lastError && (
                            <span className="text-xs text-danger-strong">
                              {job.lastError}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ))}
          </section>
        )}

        <section className="mt-4" aria-label="Webhook deliveries">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Webhook deliveries</CardTitle>
              <CardDescription>
                {health.total === 0
                  ? "Nothing received yet."
                  : `${health.total} recent deliveries. ` +
                    Object.entries(health.byStatus)
                      .map(([status, count]) => `${count} ${status.toLowerCase()}`)
                      .join(", ")}
              </CardDescription>
            </CardHeader>

            {events.length > 0 && (
              <CardContent>
                <ul className="space-y-1.5">
                  {events.map((event) => (
                    <li
                      key={event.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-xs">{event.event_type}</span>
                      <Badge variant="outline">{event.status}</Badge>
                      {!event.signature_valid && (
                        <Badge variant="outline" className="text-danger-strong">
                          signature failed
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {new Date(event.received_at).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            )}
          </Card>
        </section>
      </div>
    </AppShell>
  )
}
