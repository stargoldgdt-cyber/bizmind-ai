import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { FileSpreadsheet, Plus, Upload } from "lucide-react"

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
import { listDataSources, type DataSource } from "@/features/imports/queries"
import { formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { importEntityLabel } from "@/services/ingestion/entities"

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

  const { rows, matchedCount } = await listDataSources({ limit: 50 })
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
                    {rows.map((row) => (
                      <TableRow key={row.batch_id} className={row.withdrawn_at ? "opacity-60" : ""}>
                        <TableCell className="max-w-56">
                          <Link
                            href={`/imports/${row.batch_id}`}
                            className="block truncate font-medium underline-offset-4 hover:underline"
                          >
                            {row.file_name}
                          </Link>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {sourceLabel(row)}
                          </span>
                        </TableCell>

                        <TableCell className="text-xs">
                          {row.dataset === "LEDGER"
                            ? "Settlement"
                            : importEntityLabel(row.entity)}
                        </TableCell>

                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(row.created_at).toLocaleDateString()}
                        </TableCell>

                        <TableCell>
                          <StatusBadge row={row} />
                        </TableCell>

                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatNumber(row.row_count)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {row.created_count === null ? "—" : formatNumber(row.created_count)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {row.updated_count === null ? "—" : formatNumber(row.updated_count)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {row.rows_failed === null ? "—" : formatNumber(row.rows_failed)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {row.warnings_count === 0 ? "—" : formatNumber(row.warnings_count)}
                        </TableCell>

                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {row.withdrawn_at
                            ? "withdrawn"
                            : row.records_written === 0
                              ? "—"
                              : formatNumber(row.records_written)}
                        </TableCell>

                        <TableCell className="text-right">
                          <Link
                            href={`/imports/${row.batch_id}`}
                            className="text-xs font-medium underline-offset-4 hover:underline"
                          >
                            Details
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
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

/** Where this data came from, in the owner's language. */
function sourceLabel(row: DataSource): string {
  if (row.dataset === "LEDGER") return row.marketplace_label ?? "Marketplace file"
  if (row.connection_name) return row.connection_name
  if (row.file_type === "api") return "Synced"
  return row.source ? `File · ${row.source}` : "File"
}

function StatusBadge({ row }: { row: DataSource }) {
  if (row.withdrawn_at) {
    return (
      <span className="inline-flex rounded-4xl bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        Withdrawn
      </span>
    )
  }

  const styles: Record<string, string> = {
    COMPLETED: "bg-success-subtle text-success-strong",
    FAILED: "bg-danger-subtle text-danger-strong",
    DRAFT: "bg-muted text-muted-foreground",
    READY: "bg-info-subtle text-info-strong",
    CANCELLED: "bg-muted text-muted-foreground",
  }

  const labels: Record<string, string> = {
    COMPLETED: "Imported",
    FAILED: "Failed",
    DRAFT: "Not finished",
    READY: "Ready",
    CANCELLED: "Cancelled",
  }

  return (
    <span
      className={`inline-flex rounded-4xl px-2 py-0.5 text-[11px] font-medium ${styles[row.status]}`}
    >
      {labels[row.status]}
    </span>
  )
}
