import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AppShell } from "@/components/layout/app-shell"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import type { BusinessRole } from "@/types/database"

export const metadata: Metadata = { title: "Settings" }

type MemberRow = {
  user_id: string
  role: BusinessRole
  created_at: string
  profiles: { full_name: string | null; email: string } | { full_name: string | null; email: string }[] | null
}

/**
 * Business and team.
 *
 * READ-ONLY, ON PURPOSE.
 *
 * Everything shown here is real and comes from the database. What is NOT here
 * is any control that would only pretend to work: there is no invite flow, no
 * role editor, no notification preferences and no billing, because none of
 * those exist behind the UI yet.
 *
 * A settings page full of switches that quietly do nothing is worse than a
 * short one, and this product's whole argument is that what it shows you can
 * be trusted.
 *
 * Roles come from `business_members` and are the same values RLS enforces, so
 * what an owner reads here is exactly what the database will allow.
 */
export default async function SettingsPage() {
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()

  const [{ data: profile }, { data: members }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    supabase
      .from("business_members")
      .select("user_id, role, created_at, profiles(full_name, email)")
      .eq("business_id", activeBusiness.id)
      .order("created_at"),
  ])

  const rows = (members ?? []) as unknown as MemberRow[]

  const personOf = (row: MemberRow) =>
    Array.isArray(row.profiles) ? row.profiles[0] : row.profiles

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-3xl">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your business and who can see it.
          </p>
        </header>

        <section className="mt-8" aria-label="Business">
          <h2 className="text-sm font-semibold">Business</h2>

          <dl className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
            <Row label="Name" value={activeBusiness.name} />
            <Row label="Currency" value={activeBusiness.currency} />
            <Row
              label="Your role"
              value={activeBusiness.role.charAt(0) + activeBusiness.role.slice(1).toLowerCase()}
            />
            <Row
              label="Created"
              value={new Date(activeBusiness.created_at).toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            />
          </dl>

          <p className="mt-2 text-xs text-muted-foreground">
            Every figure in BizMind is shown in {activeBusiness.currency}. The
            currency is fixed when a business is created, because changing it
            afterwards would silently re-label historical amounts that were
            never converted.
          </p>
        </section>

        <section className="mt-10" aria-label="Team">
          <h2 className="text-sm font-semibold">Team</h2>

          <ul className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
            {rows.map((row) => {
              const person = personOf(row)
              const name = person?.full_name ?? person?.email ?? "A team member"
              const initials = name
                .split(/[\s@.]+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((part) => part[0]?.toUpperCase())
                .join("")

              return (
                <li
                  key={row.user_id}
                  className="flex items-center gap-3 border-b border-border px-5 py-3.5 last:border-0"
                >
                  <Avatar className="size-8">
                    <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                  </Avatar>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{name}</p>
                    {person?.email && person.full_name && (
                      <p className="truncate text-xs text-muted-foreground">
                        {person.email}
                      </p>
                    )}
                  </div>

                  <span className="shrink-0 rounded-4xl bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {row.role.charAt(0) + row.role.slice(1).toLowerCase()}
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="mt-3 space-y-1 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Owner</span> and{" "}
              <span className="font-medium text-foreground">Admin</span> can
              change automation rules and connect stores.{" "}
              <span className="font-medium text-foreground">Staff</span> and{" "}
              <span className="font-medium text-foreground">Viewer</span> can
              read everything and acknowledge alerts.
            </p>
            <p>
              Inviting and removing people is not built yet, so it is not
              offered here.
            </p>
          </div>
        </section>
      </div>
    </AppShell>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border px-5 py-3.5 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  )
}
