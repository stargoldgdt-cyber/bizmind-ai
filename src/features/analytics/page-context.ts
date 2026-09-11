import "server-only"

import { redirect } from "next/navigation"

import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import {
  DEFAULT_PERIOD,
  getAnalytics,
  isPeriodKey,
  resolveCustomPeriod,
  resolvePeriod,
  type AnalyticsBundle,
  type ResolvedPeriod,
} from "@/services/analytics"
import type { BusinessWithRole } from "@/types/database"

/**
 * The five things every signed-in analytics page needs.
 *
 * WHY THIS EXISTS
 * ---------------
 * Six pages were each repeating the same forty lines: resolve the user,
 * resolve the businesses, resolve the active one, redirect if there isn't
 * one, read the profile, parse the period, fetch the analytics. Repetition on
 * that scale is not a style problem — it is six chances to resolve the tenant
 * slightly differently, and the tenant boundary is the one thing in this
 * product that must never vary.
 *
 * So it is resolved once, here, from the session. No page reads a business id
 * from a URL.
 */

export type PageParams = Record<string, string | string[] | undefined>

export type AnalyticsPageContext = {
  user: { id: string; email: string }
  userName: string | null
  businesses: BusinessWithRole[]
  business: BusinessWithRole
  period: ResolvedPeriod
  analytics: AnalyticsBundle
  /** Whether the business has any sales in the selected period. */
  hasSales: boolean
}

/** Reads one query parameter, taking the first when a key repeats. */
export function param(params: PageParams, key: string): string | undefined {
  const value = params[key]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Turns the URL into a period.
 *
 * ALL DATE ARITHMETIC HAPPENS IN THE ANALYTICS SERVICE.
 *
 * This reads two strings and hands them to `resolveCustomPeriod()`, which owns
 * every rule about how a custom window is bounded and what it compares
 * against. A component that worked out its own previous window would be a
 * second definition of "the period before this one", and comparisons across
 * the product would quietly stop agreeing.
 *
 * An unparseable or reversed range falls back to the default rather than
 * throwing: a mistyped URL should show the owner their business, not an error.
 */
export function periodFromParams(params: PageParams): ResolvedPeriod {
  const range = param(params, "range")

  if (range === "custom") {
    const from = param(params, "from")
    const to = param(params, "to")

    if (from && to) {
      const fromDate = new Date(`${from}T00:00:00.000Z`)
      const toDate = new Date(`${to}T00:00:00.000Z`)

      const usable =
        !Number.isNaN(fromDate.getTime()) &&
        !Number.isNaN(toDate.getTime()) &&
        fromDate.getTime() <= toDate.getTime()

      if (usable) return resolveCustomPeriod(fromDate, toDate)
    }
  }

  return resolvePeriod(isPeriodKey(range) ? range : DEFAULT_PERIOD)
}

/**
 * Everything a signed-in analytics page needs, resolved from the session.
 *
 * Redirects to onboarding when the user has no business, which is the only
 * state in which these pages have nothing to say.
 */
export async function loadAnalyticsPage(
  params: PageParams
): Promise<AnalyticsPageContext> {
  const period = periodFromParams(params)

  const [user, businesses, business] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!business) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, analytics] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getAnalytics(business.id, period, business.currency),
  ])

  return {
    user: { id: user!.id, email: user!.email ?? "" },
    userName: profile?.full_name ?? null,
    businesses,
    business,
    period,
    analytics,
    hasSales: analytics.error === null && analytics.current.orders_count > 0,
  }
}
