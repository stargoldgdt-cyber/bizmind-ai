import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { CircleAlert } from "lucide-react"

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
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { GoogleSheetsPanel } from "@/features/integrations/components/google-sheets-panel"
import { getGoogleSetup, listSheetConnections } from "@/features/integrations/google-queries"
import {
  listConnections,
  recentWebhookEvents,
  webhookHealth,
} from "@/features/integrations/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"

export const metadata: Metadata = { title: "Integrations" }

/**
 * Integrations.
 *
 * Where BizMind gets its data: Google Sheets first, because that is the
 * connector an owner can use today, then any store connections and webhook
 * health. An owner should be able to see that a source is connected, when it
 * last worked, and whether anything is wrong -- without reading a log.
 */
export default async function IntegrationsPage({ searchParams }: PageProps<"/integrations">) {
  const [user, businesses, activeBusiness, params] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
    searchParams,
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user!.id)
    .maybeSingle()

  const [connections, health, events, googleSetup, sheets] = await Promise.all([
    listConnections(),
    webhookHealth(),
    recentWebhookEvents(10),
    getGoogleSetup(activeBusiness.id),
    listSheetConnections(activeBusiness.id),
  ])

  // Google Sheets tabs have their own section above.
  const storeConnections = connections.filter((c) => c.provider !== "GOOGLE_SHEETS")
  const outcome = typeof params.google === "string" ? params.google : null
  const canManage = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Where BizMind gets your data, when it last synced, and anything that needs attention.
          </p>
        </div>

        <GoogleSheetsPanel
          setup={googleSetup}
          canManage={canManage}
          businessCurrency={activeBusiness.currency}
          sheets={sheets}
          outcome={outcome}
        />

        <section className="space-y-4" aria-label="Store connections">
          {storeConnections.length === 0 ? (
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Online stores</CardTitle>
                <CardDescription>
                  No store is connected. Connecting Shopify or WooCommerce from this page is not
                  available yet.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            storeConnections.map((connection) => (
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
            ))
          )}
        </section>

        <section aria-label="Webhook deliveries">
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
