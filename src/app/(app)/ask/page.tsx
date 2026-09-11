import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AppShell } from "@/components/layout/app-shell"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { AskPanel } from "@/features/analytics/components/ask-panel"
import { RangeSelector } from "@/features/analytics/components/range-selector"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import {
  DEFAULT_PERIOD,
  getAnalytics,
  isPeriodKey,
  resolvePeriod,
} from "@/services/analytics"

export const metadata: Metadata = { title: "Ask BizMind" }

/**
 * Ask BizMind.
 *
 * A business analyst, not a chatbot. It answers about the period currently
 * selected, from figures the analytics engine has already computed — see
 * `ask-panel.tsx` for why the questions are a fixed list rather than a text
 * box.
 *
 * The page loads the analytics only to know whether the period has any sales.
 * The answers themselves are fetched by server actions that resolve the
 * business from the session, so nothing the browser sends can influence which
 * figures the model is shown.
 */
export default async function AskPage(props: PageProps<"/ask">) {
  const searchParams = await props.searchParams
  const rangeParam = Array.isArray(searchParams.range)
    ? searchParams.range[0]
    : searchParams.range
  const period = resolvePeriod(isPeriodKey(rangeParam) ? rangeParam : DEFAULT_PERIOD)

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

  const analytics = await getAnalytics(activeBusiness.id, period, activeBusiness.currency)
  const hasSales = analytics.error === null && analytics.current.orders_count > 0

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Ask BizMind</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {period.label} · {period.comparisonLabel} · figures in{" "}
              {activeBusiness.currency}
            </p>
          </div>
          <RangeSelector active={period.key} basePath="/ask" />
        </div>

        <div className="mt-8">
          <AskPanel range={period.key} hasSales={hasSales} />
        </div>
      </div>
    </AppShell>
  )
}
