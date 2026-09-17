import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { CircleAlert, CircleCheck, Upload } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
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
import {
  ClassifyExpenseCategory,
  RetireExpenseRuleButton,
} from "@/features/expenses/components/classify-expense-category"
import { ExpenseMonthPicker } from "@/features/expenses/components/expense-month-picker"
import {
  getExpenseBreakdown,
  getExpensePeriods,
  getExpenseQueue,
  getNetProfitAll,
  listBusinessExpenseRules,
  listExpenseCategories,
  type ExpenseBreakdownRow,
} from "@/features/expenses/queries"
import { getLedgerPeriods } from "@/features/ledger/queries"
import { firstParam } from "@/features/ledger/params"
import { formatMoney, formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { formatLedgerDay } from "@/services/ledger/display"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"

export const metadata: Metadata = {
  title: "Operating expenses",
}

/**
 * Operating expenses and Net Profit (GCC Phase 7).
 *
 * PERFORMS NO CALCULATIONS: expense_breakdown() and pnl_net_profit() work out
 * every figure in SQL. Expenses are classified automatically from their own
 * category names; only a name BizMind cannot place is listed for the owner,
 * and until it is placed Net Profit is not final.
 */

const CLASS_TITLE: Record<ExpenseBreakdownRow["cost_class"], string> = {
  UNCLASSIFIED: "Not classified yet",
  OPERATING: "Operating expenses",
  ADVERTISING: "Advertising outside the marketplaces",
  NOT_PROFIT: "Not counted in profit",
}

export default async function ExpensesPage(props: PageProps<"/ledger/expenses">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, expensePeriods, ledgerPeriods, queue, categories, rules] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getExpensePeriods(activeBusiness.id),
    getLedgerPeriods(activeBusiness.id),
    getExpenseQueue(activeBusiness.id),
    listExpenseCategories(),
    listBusinessExpenseRules(activeBusiness.id),
  ])
  const canManage = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"

  const monthKeys = [
    ...new Set([...expensePeriods.map((p) => monthKeyOf(p.month)), ...ledgerPeriods.map((p) => monthKeyOf(p.month))]),
  ]
    .sort()
    .reverse()
  const months = monthKeys.map((key) => parseLedgerMonth(key)).filter((m): m is LedgerMonth => m !== null)
  const month = parseLedgerMonth(firstParam(searchParams.month)) ?? months[0] ?? null
  if (month && !months.some((m) => m.key === month.key)) months.unshift(month)

  const [breakdown, netProfit] = month
    ? await Promise.all([getExpenseBreakdown(activeBusiness.id, month), getNetProfitAll(activeBusiness.id, month)])
    : [[], []]
  const labelOf = new Map(categories.map((c) => [c.code, c.label]))

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-6xl gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Operating expenses</h1>
            <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
              The costs of running the business, from your uploaded or synced expense sheets. They
              turn gross profit into net profit. Stock purchases, marketplace charges and tax
              payments are recognised and kept out, so nothing is counted twice.
            </p>
          </div>
          {activeBusiness.role !== "VIEWER" && (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" className="rounded-4xl">
                <Link href="/integrations">Connect a Google Sheet</Link>
              </Button>
              <Button asChild className="rounded-4xl">
                <Link href="/imports/new">
                  <Upload className="size-4" aria-hidden />
                  Upload expenses
                </Link>
              </Button>
            </div>
          )}
        </div>

        {queue.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-warning/40 bg-card">
            <div className="flex gap-3 border-b border-warning/40 bg-warning-subtle px-5 py-4">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning-strong" aria-hidden />
              <div>
                <h2 className="text-sm font-semibold">
                  {formatNumber(queue.length)} expense categor{queue.length === 1 ? "y" : "ies"} to place
                </h2>
                <p className="mt-1 text-sm">
                  BizMind does not know what these names mean, so net profit is not final for the
                  months they appear in. Say once what each one is; it applies to every month.
                  {!canManage && " Only an owner or admin can do this."}
                </p>
              </div>
            </div>
            <ul className="divide-y divide-border">
              {queue.map((row) => (
                <li key={row.match_key} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{row.category_name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatNumber(row.lines)} expense{row.lines === 1 ? "" : "s"} ·{" "}
                      {row.currencies.includes(",") ? "several currencies" : formatMoney(row.total, row.currencies)} ·{" "}
                      {formatLedgerDay(row.first_seen)} – {formatLedgerDay(row.last_seen)}
                    </p>
                  </div>
                  {canManage && row.match_key !== "" ? (
                    <ClassifyExpenseCategory categoryName={row.category_name} categories={categories} />
                  ) : row.match_key === "" ? (
                    <p className="text-sm text-muted-foreground">
                      These expenses have no category. Add one in your sheet or file and import it again.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        )}

        {month && (
          <ExpenseMonthPicker months={months.map((m) => ({ key: m.key, label: m.label }))} monthKey={month.key} />
        )}

        {!month ? (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            No expenses or marketplace figures yet.
          </p>
        ) : netProfit.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Nothing was recorded in {month.label}.
          </p>
        ) : (
          netProfit.map((n) => {
            const money = (value: string | null | undefined) => formatMoney(value, n.currency)
            const rows = breakdown.filter((b) => b.currency === n.currency)
            return (
              <section key={n.currency} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold">
                    {month.label} in {n.currency}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Gross profit from {formatNumber(n.accounts)} marketplace account{n.accounts === 1 ? "" : "s"}, less
                    the running costs of the business.
                  </p>
                </div>
                <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
                  <Table>
                    <TableBody>
                      <TableRow>
                        <TableCell className="text-sm">Gross profit (all {n.currency} marketplace accounts)</TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {n.gross_profit === null ? (
                            <Incomplete note={`${money(n.gross_profit_before_open_items)} so far`} />
                          ) : (
                            money(n.gross_profit)
                          )}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-sm">Operating expenses</TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">{money(n.operating_expenses)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="text-sm">Advertising outside the marketplaces</TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">{money(n.external_advertising)}</TableCell>
                      </TableRow>
                      <TableRow className="bg-muted/40">
                        <TableCell className="text-sm font-semibold">Net profit</TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold tabular-nums">
                          {n.net_profit === null ? (
                            <Incomplete note={`${money(n.net_profit_before_open_items)} from what is known — not final`} />
                          ) : (
                            money(n.net_profit)
                          )}
                        </TableCell>
                      </TableRow>
                      {n.net_profit === null && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-xs text-muted-foreground">
                            {reasonText(n.net_profit_reasons)}
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                {rows.length > 0 && (
                  <div className="overflow-x-auto border-t border-border [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Counts as</TableHead>
                          <TableHead>Category</TableHead>
                          <TableHead className="text-right">Expenses</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((b) => (
                          <TableRow key={`${b.cost_class}-${b.category_code ?? b.category_name}`}>
                            <TableCell className="text-xs text-muted-foreground">
                              {b.cost_class === "UNCLASSIFIED" ? (
                                <span className="inline-flex items-center gap-1 text-warning-strong">
                                  <CircleAlert className="size-3.5" aria-hidden />
                                  {CLASS_TITLE.UNCLASSIFIED}
                                </span>
                              ) : (
                                CLASS_TITLE[b.cost_class]
                              )}
                            </TableCell>
                            <TableCell className="text-sm">{b.category_label ?? b.category_name ?? "(no category)"}</TableCell>
                            <TableCell className="text-right font-mono text-xs tabular-nums">{formatNumber(b.lines)}</TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">{money(b.total)}</TableCell>
                          </TableRow>
                        ))}
                        {n.not_in_profit !== "0.0000" && (
                          <TableRow>
                            <TableCell colSpan={4} className="text-xs text-muted-foreground">
                              {money(n.not_in_profit)} is recorded but not counted in profit (see above).
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>
            )
          })
        )}

        {rules.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold">Your expense classifications</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Category names you placed. Undoing one sends its expenses back to the list above.
              </p>
            </div>
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Your category name</TableHead>
                    <TableHead>Counts as</TableHead>
                    <TableHead>Since</TableHead>
                    {canManage && <TableHead className="text-right">Action</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm">{r.match_key}</TableCell>
                      <TableCell className="text-sm">
                        <span className="inline-flex items-center gap-1">
                          <CircleCheck className="size-3.5 text-success-strong" aria-hidden />
                          {labelOf.get(r.category_code) ?? r.category_code}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatLedgerDay(r.created_at)}</TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          <RetireExpenseRuleButton ruleId={r.id} />
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}
      </div>
    </AppShell>
  )
}

function Incomplete({ note }: { note: string }) {
  return (
    <span className="inline-grid justify-items-end gap-0.5 font-sans">
      <span className="inline-flex items-center gap-1 text-xs text-warning-strong">
        <CircleAlert className="size-3.5" aria-hidden />
        Incomplete
      </span>
      <span className="text-[11px] text-muted-foreground">{note}</span>
    </span>
  )
}

const REASON_TEXT: Record<string, string> = {
  UNKNOWN_LINES: "some marketplace lines are not recognised",
  VAT_TREATMENT_UNKNOWN: "VAT on marketplace fees has no setting",
  FEE_VAT_NOT_SEPARATED: "marketplace fees still include VAT",
  ROW_ERRORS: "some marketplace rows could not be read",
  SKU_NOT_MAPPED: "some SKUs are not matched to a product",
  COST_MISSING: "some products have no cost for the sale date",
  NO_MARKETPLACE_DATA: "there are no marketplace figures for this month",
  EXPENSES_UNCLASSIFIED: "some expense categories are not placed yet",
}

function reasonText(reasons: string[]): string {
  const parts = reasons.map((r) => REASON_TEXT[r] ?? r)
  return parts.length === 0 ? "" : `Not final because ${parts.join("; ")}.`
}
