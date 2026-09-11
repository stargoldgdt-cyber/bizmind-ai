import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AppShell } from "@/components/layout/app-shell"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { explainSkip } from "@/services/automation/contracts"
import type { AutomationRunStatus } from "@/types/database"

export const metadata: Metadata = { title: "Activity" }

type RunRow = {
  id: string
  evaluated_at: string
  status: AutomationRunStatus
  metric_value: string | null
  threshold: string | null
  skipped_reason: string | null
  automation_rules: { name: string; metric: string } | { name: string; metric: string }[] | null
}

/**
 * Activity.
 *
 * EVERY CHECK, INCLUDING THE ONES THAT RAISED NOTHING.
 *
 * A list of alerts records what happened. Only this records what did NOT, and
 * why — and that is the harder question, because it is asked after something
 * has already gone wrong. "Why didn't anyone tell me?" needs an answer, and
 * without this page the honest answer would be "we don't know either".
 *
 * The reasons are the database's own: it was inside its cooldown, the period
 * had nothing to measure, or the cost data was too incomplete to judge a
 * profit figure. Each is translated into a sentence by `explainSkip()`.
 *
 * Read as the signed-in user, so RLS scopes it to this business.
 */
export default async function ActivityPage() {
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()

  const [{ data: profile }, { data: runs }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    supabase
      .from("automation_runs")
      .select(
        "id, evaluated_at, status, metric_value, threshold, skipped_reason, " +
          "automation_rules(name, metric)"
      )
      .eq("business_id", activeBusiness.id)
      .order("evaluated_at", { ascending: false })
      .limit(60),
  ])

  const rows = (runs ?? []) as unknown as RunRow[]

  const rule = (row: RunRow) =>
    Array.isArray(row.automation_rules)
      ? row.automation_rules[0]
      : row.automation_rules

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-4xl">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            Every time BizMind checked one of your rules — including the checks
            that raised nothing, and why.
          </p>
        </header>

        {rows.length === 0 ? (
          <p className="mt-8 rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            No checks have run yet. Once you have a rule, every check it makes
            is recorded here.
          </p>
        ) : (
          <ul className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-1 border-b border-border px-5 py-3.5 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {rule(row)?.name ?? "A deleted rule"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <Outcome row={row} />
                  </p>
                </div>

                <time
                  dateTime={row.evaluated_at}
                  className="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums"
                >
                  {new Date(row.evaluated_at).toLocaleString(undefined, {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          Showing the most recent 60 checks.
        </p>
      </div>
    </AppShell>
  )
}

/** What came of one check, in a sentence. */
function Outcome({ row }: { row: RunRow }) {
  if (row.status === "FIRED") {
    return (
      <span className="text-warning-strong">
        Raised an alert — the figure was {row.metric_value}, your limit is{" "}
        {row.threshold}
      </span>
    )
  }

  if (row.status === "NOT_MATCHED") {
    return (
      <span className="text-success-strong">
        All clear — {row.metric_value} is within your limit of {row.threshold}
      </span>
    )
  }

  if (row.status === "SKIPPED") {
    return <>Stayed quiet. {explainSkip(row.skipped_reason)}</>
  }

  return (
    <span className="text-danger-strong">
      Could not be checked. This has been logged for us to look at.
    </span>
  )
}
