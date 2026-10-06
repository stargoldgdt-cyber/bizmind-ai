import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { FileSpreadsheet, Plus, Upload } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { HistoryGroup, HistoryRow } from "@/features/imports/components/history-rows"
import { groupDataSources } from "@/features/imports/groups"
import { listDataSources } from "@/features/imports/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"

export const metadata: Metadata = {
  title: "Data sources",
}

/**
 * Data sources: everything that has ever put data into this business.
 *
 * Files, sheet syncs and webhook deliveries in one list, because from an
 * owner's point of view they are the same thing — something that wrote records
 * — and the question they arrive with ("where did THAT come from, and can I
 * take it out?") is the same for all three.
 *
 * Each row says what it wrote and how well BizMind knows what that was. That
 * last part decides whether it can be withdrawn, and the detail page explains
 * it rather than hiding a disabled button.
 */
export default async function DataSourcesPage() {
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

  const { rows, matchedCount } = await listDataSources({ limit: 200 })
  // A large file is recorded in parts; they show as one file, parts a click away.
  const entries = groupDataSources(rows)
  const canImport = activeBusiness.role !== "VIEWER"

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Data sources</h1>
            <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
              Every file, sync and delivery that has put data into{" "}
              {activeBusiness.name} — what it wrote, and whether it can be taken
              back out.
            </p>
          </div>
          {canImport && (
            <div className="flex flex-wrap gap-2">
              <Button asChild className="rounded-4xl">
                <Link href="/imports/settlement">
                  <Upload className="size-4" aria-hidden />
                  Upload a settlement
                </Link>
              </Button>
              <Button asChild variant="outline" className="rounded-4xl">
                <Link href="/imports/new">
                  <Plus className="size-4" aria-hidden />
                  Upload expenses
                </Link>
              </Button>
            </div>
          )}
        </div>

        <Card className="mt-6 shadow-none">
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>
              Re-importing the same file updates the same records rather than
              duplicating them. Withdrawing one takes its records out of your
              figures without deleting anything.
            </CardDescription>
          </CardHeader>

          <CardContent className="px-0">
            {rows.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                <span className="flex size-11 items-center justify-center rounded-md bg-accent text-accent-foreground">
                  <FileSpreadsheet className="size-5" aria-hidden />
                </span>
                <p className="font-heading text-lg font-semibold">Nothing uploaded yet</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  Upload your marketplace settlement reports (Amazon, noon) and
                  BizMind works out sales, fees and profit from them.
                </p>
                {canImport && (
                  <Button asChild className="mt-2 rounded-4xl">
                    <Link href="/imports/settlement">Upload a settlement</Link>
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead>Contains</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Rows</TableHead>
                      <TableHead className="text-right">Added</TableHead>
                      <TableHead className="text-right">Updated</TableHead>
                      <TableHead className="text-right">Skipped</TableHead>
                      <TableHead className="text-right">Warnings</TableHead>
                      <TableHead className="text-right">In your figures</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>

                  <TableBody>
                    {entries.map((entry) =>
                      entry.kind === "group" ? (
                        <HistoryGroup key={entry.key} group={entry} />
                      ) : (
                        <HistoryRow key={entry.row.batch_id} row={entry.row} />
                      )
                    )}
                  </TableBody>
                </Table>

                {matchedCount > rows.length && (
                  <p className="px-4 pt-3 text-xs text-muted-foreground">
                    Showing the {rows.length} most recent of {matchedCount}.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
