import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AppShell } from "@/components/layout/app-shell"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { ExpenseMonthPicker } from "@/features/expenses/components/expense-month-picker"
import { getExpensePeriods } from "@/features/expenses/queries"
import { LedgerAskPanel } from "@/features/ledger-ask/components/ledger-ask-panel"
import { firstParam } from "@/features/ledger/params"
import { getLedgerPeriods } from "@/features/ledger/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { isAiConfigured, LEDGER_QUESTIONS, type LedgerQuestion } from "@/services/ai"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"

export const metadata: Metadata = { title: "Ask about your marketplaces" }

/**
 * Ask BizMind, on the marketplace ledger (GCC Phase 9).
 *
 * Compute first, then narrate: each question is answered from one month's
 * figures the SQL readers produced, checked by the AI guard, and shown with
 * the figures themselves.
 */
export default async function LedgerAskPage(props: PageProps<"/ledger/ask">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, ledgerPeriods, expensePeriods] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getLedgerPeriods(activeBusiness.id),
    getExpensePeriods(activeBusiness.id),
  ])

  const months = [...new Set([...ledgerPeriods, ...expensePeriods].map((p) => monthKeyOf(p.month)))]
    .sort()
    .reverse()
    .map((key) => parseLedgerMonth(key))
    .filter((m): m is LedgerMonth => m !== null)
  const month = parseLedgerMonth(firstParam(searchParams.month)) ?? months[0] ?? null
  if (month && !months.some((m) => m.key === month.key)) months.unshift(month)

  const questions = (Object.keys(LEDGER_QUESTIONS) as LedgerQuestion[]).map((key) => ({
    key,
    ask: LEDGER_QUESTIONS[key],
  }))

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-5xl gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Ask about your marketplaces</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            Plain-language answers about one month, written only from the figures BizMind has already
            worked out from your marketplace reports. Every answer shows the figures it used; an
            answer containing any other number is thrown away.
          </p>
        </div>

        {!isAiConfigured() && (
          <p className="rounded-xl border border-border bg-card px-5 py-3 text-sm text-muted-foreground">
            Written answers are switched off on this server. The figures are still shown for each question.
          </p>
        )}

        {month ? (
          <>
            <ExpenseMonthPicker
              basePath="/ledger/ask"
              months={months.map((m) => ({ key: m.key, label: m.label }))}
              monthKey={month.key}
            />
            <LedgerAskPanel key={month.key} questions={questions} month={month.key} />
          </>
        ) : (
          <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
            No figures yet. Upload a marketplace report to start.
          </p>
        )}
      </div>
    </AppShell>
  )
}
