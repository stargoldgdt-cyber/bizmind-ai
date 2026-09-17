import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { CircleAlert, CircleCheck, Download, ExternalLink, FileSpreadsheet, Loader } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { ExpenseMonthPicker } from "@/features/expenses/components/expense-month-picker"
import { getExpensePeriods } from "@/features/expenses/queries"
import { firstParam, ledgerHref } from "@/features/ledger/params"
import { getLedgerPeriods } from "@/features/ledger/queries"
import { SheetsExportButton } from "@/features/reports/components/sheets-export-button"
import { getGoogleConnected, listRecentExports } from "@/features/reports/exports"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { formatLedgerDay } from "@/services/ledger/display"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"
import { REPORT_CATALOG, REPORT_KEYS } from "@/services/reports/catalog"

export const metadata: Metadata = {
  title: "Reports",
}

/**
 * The report catalogue (GCC Phase 8). Each report is an Excel workbook of the
 * same figures the screens show, computed in the database, or a copy in a NEW
 * Google Sheet that BizMind creates. A blank figure is not final; its status
 * column says why.
 */
export default async function ReportsPage(props: PageProps<"/ledger/reports">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, ledgerPeriods, expensePeriods, googleConnected, exports] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getLedgerPeriods(activeBusiness.id),
    getExpensePeriods(activeBusiness.id),
    getGoogleConnected(activeBusiness.id),
    listRecentExports(activeBusiness.id),
  ])
  const canExport = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"

  const months = [...new Set([...ledgerPeriods, ...expensePeriods].map((p) => monthKeyOf(p.month)))]
    .sort()
    .reverse()
    .map((key) => parseLedgerMonth(key))
    .filter((m): m is LedgerMonth => m !== null)
  const month = parseLedgerMonth(firstParam(searchParams.month)) ?? months[0] ?? null
  if (month && !months.some((m) => m.key === month.key)) months.unshift(month)

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-5xl gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            Download the figures behind every screen as an Excel workbook, or copy them into a new
            Google Sheet, to keep, share or check against the marketplaces&apos; own reports. A blank
            figure is not final; the column beside it says why.
          </p>
        </div>

        {month ? (
          <ExpenseMonthPicker
            basePath="/ledger/reports"
            months={months.map((m) => ({ key: m.key, label: m.label }))}
            monthKey={month.key}
          />
        ) : (
          <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
            No figures yet. Upload a marketplace report to start.
          </p>
        )}

        <ul className="grid gap-3 sm:grid-cols-2">
          {REPORT_KEYS.map((key) => {
            const report = REPORT_CATALOG[key]
            const needsMonth = report.monthly && key !== "payouts"
            const disabled = needsMonth && !month
            return (
              <li key={key} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
                <div className="flex items-start gap-3">
                  <FileSpreadsheet className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div>
                    <h2 className="text-sm font-semibold">{report.title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{report.description}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {report.monthly && month ? month.label : "All periods"}
                    </p>
                  </div>
                </div>
                <div className="mt-auto flex flex-wrap items-start gap-2">
                  {disabled ? (
                    <Button size="sm" variant="outline" className="rounded-4xl" disabled>
                      <Download className="size-4" aria-hidden />
                      Excel
                    </Button>
                  ) : (
                    <Button asChild size="sm" variant="outline" className="rounded-4xl">
                      <a href={ledgerHref(`/api/v1/reports/${key}`, { month: report.monthly ? month?.key : null })}>
                        <Download className="size-4" aria-hidden />
                        Excel
                      </a>
                    </Button>
                  )}
                  {canExport && googleConnected && !disabled && (
                    <SheetsExportButton report={key} month={report.monthly ? (month?.key ?? null) : null} />
                  )}
                </div>
              </li>
            )
          })}
        </ul>

        {canExport && !googleConnected && (
          <p className="text-sm text-muted-foreground">
            To copy reports into Google Sheets,{" "}
            <Link href="/integrations" className="font-medium text-foreground underline underline-offset-4">
              connect Google
            </Link>
            . BizMind only ever writes to new spreadsheets it creates for an export.
          </p>
        )}

        {exports.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold">Google Sheets exports</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Each export is a new spreadsheet in your Google Drive. BizMind never changes it afterwards.
              </p>
            </div>
            <ul className="divide-y divide-border">
              {exports.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <div>
                    <p className="font-medium">{REPORT_CATALOG[e.report_key]?.title ?? e.report_key}</p>
                    <p className="text-xs text-muted-foreground">
                      {e.month_key ? (parseLedgerMonth(e.month_key)?.label ?? e.month_key) : "All periods"} · requested{" "}
                      {formatLedgerDay(e.created_at)}
                    </p>
                  </div>
                  {e.status === "SUCCEEDED" && e.spreadsheet_url ? (
                    <a
                      href={e.spreadsheet_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-success-strong underline-offset-4 hover:underline"
                    >
                      <CircleCheck className="size-3.5" aria-hidden />
                      Open the sheet
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : e.status === "FAILED" ? (
                    <span className="inline-flex max-w-md items-start gap-1 text-xs text-danger-strong">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {e.error ?? "The export failed."}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader className="size-3.5" aria-hidden />
                      {e.status === "RUNNING" ? "Creating the sheet…" : "Waiting to start"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </AppShell>
  )
}
