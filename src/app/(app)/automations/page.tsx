import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AppShell } from "@/components/layout/app-shell"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { RulePanel } from "@/features/automation/components/rule-panel"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { listRuleRuns, listRules, RULE_TEMPLATES } from "@/services/automation"

export const metadata: Metadata = { title: "Automations" }

/**
 * Automations.
 *
 * The rules themselves. Alerts — what those rules produced — live on their own
 * page, because they are read at different moments: alerts when something
 * happened, rules when deciding what should count as something happening.
 *
 * V1 IS DETERMINISTIC AND IT ENDS AT AN ALERT.
 * A rule fires because a number crossed a line the owner chose, compared in
 * SQL. Nothing here buys, prices, emails a customer, or changes a store, and
 * no model gets a vote in whether a rule fires. That is a product decision,
 * not an unfinished feature.
 */
export default async function AutomationsPage() {
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, rules] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listRules(activeBusiness.id),
  ])

  const runsByRule = Object.fromEntries(
    await Promise.all(
      rules.map(async (rule) => [rule.id, await listRuleRuns(rule.id, 5)] as const)
    )
  )

  const canEdit = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-4xl">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Automations</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            Rules BizMind checks on a schedule. Each one raises an alert when a
            figure crosses the line you set — and does nothing else.
          </p>
        </header>

        <div className="mt-8">
          <RulePanel
            rules={rules}
            runsByRule={runsByRule}
            templates={RULE_TEMPLATES.map((template) => ({
              id: template.id,
              name: template.rule.name,
              concern: template.concern,
              rationale: template.rationale,
              alreadyAdded: rules.some((rule) => rule.name === template.rule.name),
            }))}
            canEdit={canEdit}
          />
        </div>
      </div>
    </AppShell>
  )
}
