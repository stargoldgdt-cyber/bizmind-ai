import "server-only"

import { cookies } from "next/headers"

import { createClient } from "@/lib/supabase/server"
import type { BusinessWithRole } from "@/types/database"

/**
 * Reading tenancy state.
 *
 * Every query here is scoped by Row Level Security in the database, so these
 * functions physically cannot return another business's rows — even if the
 * code were wrong. The application-side scoping below is a second layer, not
 * the only one.
 */

/** Cookie holding which business the user is currently looking at. */
export const ACTIVE_BUSINESS_COOKIE = "bizmind_active_business"

/**
 * Every business the signed-in user belongs to, with their role in each.
 *
 * No `.eq("user_id", …)` filter is needed: the RLS policy on business_members
 * already restricts the rows to this user's own memberships.
 */
export async function getUserBusinesses(): Promise<BusinessWithRole[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("business_members")
    .select("role, businesses(*)")
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`Could not load your businesses: ${error.message}`)
  }

  return (data ?? [])
    .filter(
      (row): row is typeof row & { businesses: NonNullable<typeof row.businesses> } =>
        row.businesses !== null
    )
    .map((row) => ({ ...row.businesses, role: row.role }))
}

/**
 * The business the user is currently working in.
 *
 * The cookie is a *hint*, never an authority. Its value is checked against the
 * list of businesses the user actually belongs to, so tampering with it cannot
 * grant access to anything — it simply falls back to their first business.
 * This is the rule for every client-supplied identifier in a multi-tenant
 * system: verify server-side, never trust.
 *
 * Returns null when the user has no business yet, which routes them to
 * onboarding.
 */
export async function getActiveBusiness(): Promise<BusinessWithRole | null> {
  const businesses = await getUserBusinesses()
  if (businesses.length === 0) return null

  const cookieStore = await cookies()
  const requestedId = cookieStore.get(ACTIVE_BUSINESS_COOKIE)?.value

  const requested = requestedId
    ? businesses.find((business) => business.id === requestedId)
    : undefined

  return requested ?? businesses[0]
}
