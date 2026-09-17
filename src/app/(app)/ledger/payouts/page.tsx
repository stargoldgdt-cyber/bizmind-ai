import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { CircleAlert, CircleCheck, Info, Landmark } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
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
import { ExpenseMonthPicker } from "@/features/expenses/components/expense-month-picker"
import { firstParam } from "@/features/ledger/params"
import { getExpectedCashflow, getExpectedPayouts, type ExpectedPayoutRow } from "@/features/payouts/queries"
import { formatMoney, formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { formatLedgerDay } from "@/services/ledger/display"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"
import {
  BANK_RECEIPT_LABEL,
  BANK_RECEIPT_STATUS_LABEL,
  EXPECTED_PAYOUT_LABEL,
  PAYOUT_SOURCE_LABEL,
  PAYOUT_STATUS_HELP,
  PAYOUT_STATUS_LABEL,
} from "@/services/payouts/labels"

export const metadata: Metadata = {
  title: "Payouts and cashflow",
}

/**
 * Expected marketplace payouts and cashflow (GCC Phase 8).
 *
 * PERFORMS NO CALCULATIONS: expected_payouts() and expected_cashflow() work
 * out every figure in SQL.
 *
 * THE OWNER'S RULE: an amount from a marketplace report is an EXPECTED payout,
 * never money received. "Actual bank receipt" is shown beside it as its own
 * column and reads "Not connected" until a real bank source exists. Nothing
 * here invents or implies a bank transaction.
 */
export default async function PayoutsPage(props: PageProps<"/ledger/payouts">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, cashflow] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getExpectedCashflow(activeBusiness.id),
  ])

  const months = [...new Set(cashflow.map((c) => monthKeyOf(c.month)))]
    .sort()
    .reverse()
    .map((key) => parseLedgerMonth(key))
    .filter((m): m is LedgerMonth => m !== null)
  const month = parseLedgerMonth(firstParam(searchParams.month)) ?? months[0] ?? null
  if (month && !months.some((m) => m.key === month.key)) months.unshift(month)

  const payouts = month ? await getExpectedPayouts(activeBusiness.id, month, null) : []
  const undated = (await getExpectedPayouts(activeBusiness.id, null, null)).filter((p) => p.expected_date === null)

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-6xl gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Payouts and cashflow</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            What your marketplaces report they will pay you, and when. Each Amazon settlement&apos;s
            reported total is its expected payout; noon reports its payments directly.
          </p>
        </div>

        <section className="flex gap-3 rounded-xl border border-info/40 bg-info-subtle px-5 py-4 text-sm">
          <Landmark className="mt-0.5 size-4 shrink-0 text-info-strong" aria-hidden />
          <div>
            <p className="font-medium">
              {BANK_RECEIPT_LABEL}: {BANK_RECEIPT_STATUS_LABEL.NOT_CONNECTED}
            </p>
            <p className="mt-1">
              No bank account is connected, so BizMind cannot confirm what reached your bank. Every
              amount on this page is an expected payout from the marketplace&apos;s own report — use it
              for planning, not as money received.
            </p>
          </div>
        </section>

        {/* ---- by month ---------------------------------------------------- */}
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">Expected cash inflow by month</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Grouped by the date the marketplace gives for each payout.
            </p>
          </div>
          {cashflow.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No expected payouts yet. Upload an Amazon settlement report or a noon Transaction View.{" "}
              <Link href="/imports/settlement" className="font-medium text-foreground underline underline-offset-4">
                Upload a report
              </Link>
            </p>
          ) : (
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Payouts</TableHead>
                    <TableHead className="text-right">{EXPECTED_PAYOUT_LABEL}s</TableHead>
                    <TableHead className="text-right">Of which in doubt</TableHead>
                    <TableHead className="text-right">{BANK_RECEIPT_LABEL}s</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cashflow.map((c) => (
                    <TableRow key={`${c.month}-${c.currency}`}>
                      <TableCell className="text-sm">
                        <Link
                          href={`/ledger/payouts?month=${monthKeyOf(c.month)}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {parseLedgerMonth(monthKeyOf(c.month))?.label ?? c.month}
                        </Link>
                        <span className="ml-1 text-[11px] text-muted-foreground">{c.currency}</span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">
                        {formatNumber(c.expected_payouts)}
                        {c.payouts_without_amount > 0 && (
                          <span className="block text-[11px] text-muted-foreground">
                            {formatNumber(c.payouts_without_amount)} without an amount
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">
                        {formatMoney(c.expected_inflow, c.currency)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">
                        {c.payouts_in_doubt === 0 ? "—" : formatMoney(c.amount_in_doubt, c.currency)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {BANK_RECEIPT_STATUS_LABEL[c.bank_receipt_status]}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {month && (
          <>
            <ExpenseMonthPicker
              basePath="/ledger/payouts"
              months={months.map((m) => ({ key: m.key, label: m.label }))}
              monthKey={month.key}
            />
            <PayoutTable title={`Expected payouts in ${month.label}`} rows={payouts} />
          </>
        )}

        {undated.length > 0 && (
          <PayoutTable
            title="Expected payouts with no date"
            rows={undated}
            note="The report gives no payout date, so these are not placed in any month."
          />
        )}
      </div>
    </AppShell>
  )
}

function PayoutTable({ title, rows, note }: { title: string; rows: ExpectedPayoutRow[]; note?: string }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <p className="mt-1 text-sm text-muted-foreground">{note}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">None.</p>
      ) : (
        <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Expected on</TableHead>
                <TableHead className="text-right">{EXPECTED_PAYOUT_LABEL}</TableHead>
                <TableHead>Marketplace check</TableHead>
                <TableHead className="text-right">{BANK_RECEIPT_LABEL}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.payout_key}>
                  <TableCell className="text-sm">
                    {p.account_label}
                    <span className="block text-[11px] text-muted-foreground">{PAYOUT_SOURCE_LABEL[p.source]}</span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.source_file_id ? (
                      <Link href={`/imports/${p.source_file_id}`} className="font-mono underline-offset-4 hover:underline">
                        {p.reference ?? "—"}
                      </Link>
                    ) : (
                      <span className="font-mono">{p.reference ?? "—"}</span>
                    )}
                    {p.period_start && (
                      <span className="block text-[11px] text-muted-foreground">
                        {formatLedgerDay(p.period_start)} – {formatLedgerDay(p.period_end)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{formatLedgerDay(p.expected_date)}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {p.expected_amount === null ? "—" : formatMoney(p.expected_amount, p.currency)}
                  </TableCell>
                  <TableCell>
                    <StatusCell row={p} />
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {BANK_RECEIPT_STATUS_LABEL[p.bank_receipt_status]}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

function StatusCell({ row }: { row: ExpectedPayoutRow }) {
  const label = PAYOUT_STATUS_LABEL[row.marketplace_status]
  const help = PAYOUT_STATUS_HELP[row.marketplace_status]
  if (row.marketplace_status === "ADDS_UP") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success-strong" title={help}>
        <CircleCheck className="size-3.5" aria-hidden />
        {label}
      </span>
    )
  }
  if (row.marketplace_status === "DOES_NOT_ADD_UP" || row.marketplace_status === "NO_TOTAL") {
    return (
      <span className="grid gap-0.5 text-xs">
        <span className="inline-flex items-center gap-1 font-medium text-danger-strong">
          <CircleAlert className="size-3.5" aria-hidden />
          {label}
        </span>
        {row.marketplace_status === "DOES_NOT_ADD_UP" && (
          <span className="text-[11px] text-muted-foreground">
            Lines add up to {formatMoney(row.settlement_lines_total, row.currency)}
          </span>
        )}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={help}>
      <Info className="size-3.5" aria-hidden />
      {label}
    </span>
  )
}
