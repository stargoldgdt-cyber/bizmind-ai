import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { FileSpreadsheet, Plus } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { getImportHistory } from "@/features/imports/queries"
import { formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import type { ImportStatus } from "@/types/database"

export const metadata: Metadata = {
  title: "Imports",
}

/**
 * Import history — the audit trail.
 *
 * Every file that was ever loaded, what it contained, and what it produced.
 * When a figure on the dashboard looks wrong months from now, this is where
 * the explanation starts.
 */
export default async function ImportsPage() {
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

  const history = await getImportHistory()
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
            <h1 className="text-2xl font-bold tracking-tight">Imports</h1>
            <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
              Every file loaded into {activeBusiness.name}, and what it produced.
            </p>
          </div>
          {canImport && (
            <Button asChild className="rounded-4xl">
              <Link href="/imports/new">
                <Plus className="size-4" aria-hidden />
                Import a file
              </Link>
            </Button>
          )}
        </div>

        <Card className="mt-6 shadow-none">
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>
              Re-importing the same file updates the same records rather than
              duplicating them.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {history.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                <span className="flex size-11 items-center justify-center rounded-md bg-accent text-accent-foreground">
                  <FileSpreadsheet className="size-5" aria-hidden />
                </span>
                <p className="font-heading text-lg font-semibold">Nothing imported yet</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  Load a sales export to see real revenue and margin, or a product
                  list to fill in the cost prices your dashboard is missing.
                </p>
                {canImport && (
                  <Button asChild className="mt-2 rounded-4xl">
                    <Link href="/imports/new">Import a file</Link>
                  </Button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead>Contains</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Rows</TableHead>
                      <TableHead className="text-right">Imported</TableHead>
                      <TableHead className="text-right">Skipped</TableHead>
                      <TableHead>When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((batch) => (
                      <TableRow key={batch.id}>
                        <TableCell className="max-w-56 truncate font-medium">
                          {batch.file_name}
                        </TableCell>
                        <TableCell className="text-xs">
                          {batch.entity.charAt(0) + batch.entity.slice(1).toLowerCase()}
                          {batch.source && (
                            <span className="text-muted-foreground"> · {batch.source}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={batch.status} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatNumber(batch.row_count)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {batch.created_count === null && batch.updated_count === null
                            ? "—"
                            : formatNumber((batch.created_count ?? 0) + (batch.updated_count ?? 0))}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {batch.rows_failed === null ? "—" : formatNumber(batch.rows_failed)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(batch.created_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}

function StatusBadge({ status }: { status: ImportStatus }) {
  const styles: Record<ImportStatus, string> = {
    COMPLETED: "bg-success-subtle text-success-strong",
    FAILED: "bg-danger-subtle text-danger-strong",
    DRAFT: "bg-muted text-muted-foreground",
    READY: "bg-info-subtle text-info-strong",
    CANCELLED: "bg-muted text-muted-foreground",
  }

  const labels: Record<ImportStatus, string> = {
    COMPLETED: "Imported",
    FAILED: "Failed",
    DRAFT: "Not finished",
    READY: "Ready",
    CANCELLED: "Cancelled",
  }

  return (
    <span
      className={`inline-flex rounded-4xl px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  )
}
