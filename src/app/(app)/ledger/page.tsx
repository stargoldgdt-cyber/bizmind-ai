import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { CircleAlert, CircleCheck, Download, Info, Upload } from "lucide-react"

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
import { FigureCard } from "@/features/ledger/components/figure-card"
import { LedgerFilters } from "@/features/ledger/components/ledger-filters"
import { firstParam, ledgerHref } from "@/features/ledger/params"
import {
  getLedgerMonth,
  getLedgerPeriods,
  listLedgerAccounts,
  type LedgerAccount,
  type LedgerMonthData,
} from "@/features/ledger/queries"
import { formatMoney, formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import {
  CLASSIFICATION_STATUS_LABEL,
  FINANCIAL_TYPE_LABEL,
  INPUT_VAT_TREATMENT_LABEL,
  TREATMENT_LABEL,
  formatLedgerDay,
  unsignedAmount,
} from "@/services/ledger/display"
import type { PnlSummaryRow } from "@/services/ledger/export"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"

export const metadata: Metadata = {
  title: "Marketplace profit",
}

/**
 * Marketplace profit: the live dashboard on the ledger (GCC Phase 4).
 *
 * PERFORMS NO CALCULATIONS. Every figure is computed by the P&L engine in SQL
 * (pnl_summary, pnl_breakdown, pnl_settlements) and arrives as exact text.
 * This page decides only what to show and how to say it.
 *
 * NOTHING INCOMPLETE LOOKS FINAL. While a code is unrecognised, a row is
 * unreadable or the VAT setting is Unknown, the affected figures carry an
 * Incomplete label and contribution shows no number -- only an informational
 * figure labelled "not final" (decision B1).
 *
 * Account and month live in the URL, so every view can be bookmarked and
 * checked against the marketplace's own report.
 */
export default async function LedgerOverviewPage(props: PageProps<"/ledger">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, accounts, periods] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listLedgerAccounts(activeBusiness.id),
    getLedgerPeriods(activeBusiness.id),
  ])

  const requested = firstParam(searchParams.account)
  const account =
    accounts.find((a) => a.id === requested) ??
    accounts.find((a) => periods.some((p) => p.marketplace_account_id === a.id)) ??
    accounts[0] ??
    null

  const monthOptions: LedgerMonth[] = account
    ? periods
        .filter((p) => p.marketplace_account_id === account.id)
        .map((p) => parseLedgerMonth(monthKeyOf(p.month)))
        .filter((m): m is LedgerMonth => m !== null)
    : []
  const month = parseLedgerMonth(firstParam(searchParams.month)) ?? monthOptions[0] ?? null
  if (month && !monthOptions.some((m) => m.key === month.key)) monthOptions.unshift(month)

  const data = account && month ? await getLedgerMonth(activeBusiness.id, account.id, month) : null
  const canImport = activeBusiness.role !== "VIEWER"

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
            <h1 className="text-2xl font-bold tracking-tight">Marketplace profit</h1>
            <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
              Worked out from your marketplaces&apos; own settlement lines, classified
              automatically. Every figure opens into the lines behind it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {data?.summary && account && month && (
              <Button asChild variant="outline" className="rounded-4xl">
                <a href={ledgerHref("/api/v1/ledger/export", { account: account.id, month: month.key })}>
                  <Download className="size-4" aria-hidden />
                  Export for checking
                </a>
              </Button>
            )}
            {canImport && (
              <Button asChild className="rounded-4xl">
                <Link href="/imports/settlement">
                  <Upload className="size-4" aria-hidden />
                  Upload a settlement
                </Link>
              </Button>
            )}
          </div>
        </div>

        {!account ? (
          <EmptyState
            title="Add a marketplace account first"
            body="Figures are worked out per marketplace account, in its own currency."
            href="/marketplaces"
            action="Marketplace accounts"
          />
        ) : (
          <>
            <LedgerFilters
              accounts={accounts.map((a) => ({
                id: a.id,
                label: a.label,
                detail: `${a.marketplace_code} · ${a.currency}`,
              }))}
              months={monthOptions.map((m) => ({ key: m.key, label: m.label }))}
              accountId={account.id}
              monthKey={month?.key ?? null}
            />

            {!month || !data ? (
              <EmptyState
                title="No settlement lines for this account yet"
                body="Upload a settlement file for this account and its figures appear here."
                href="/imports/settlement"
                action="Upload a settlement"
              />
            ) : !data.summary ? (
              <EmptyState
                title={`No lines were posted in ${month.label}`}
                body="Choose another month, or upload the settlement that covers this one."
                href="/imports/settlement"
                action="Upload a settlement"
              />
            ) : (
              <MonthView
                summary={data.summary}
                data={data}
                account={account}
                month={month}
                isOwner={activeBusiness.role === "OWNER"}
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}

function MonthView({
  summary: s,
  data,
  account,
  month,
  isOwner,
}: {
  summary: PnlSummaryRow
  data: LedgerMonthData
  account: LedgerAccount
  month: LedgerMonth
  isOwner: boolean
}) {
  const money = (value: string | null | undefined) => formatMoney(value, s.currency)
  const lines = (params: Record<string, string | null | undefined>) =>
    ledgerHref("/ledger/lines", { account: account.id, month: month.key, ...params })

  const reasons = s.incomplete_reasons
  const onlyVatOpen = reasons.length === 1 && reasons[0] === "VAT_TREATMENT_UNKNOWN"
  const incomplete = s.contribution_status === "INCOMPLETE" || s.figures_status === "INCOMPLETE"
  const figures = s.figures_status

  const statement: { label: string; value: string | null; href?: string; total?: boolean; hidden?: boolean }[] = [
    { label: "Gross sales", value: s.gross_sales, href: lines({ group: "GROSS_SALES" }) },
    { label: "Sales refunds and returns", value: s.sales_refunds, href: lines({ group: "SALES_REFUNDS" }) },
    { label: "Seller-funded discounts", value: s.seller_discounts, href: lines({ group: "SELLER_DISCOUNTS" }) },
    { label: "Net sales", value: s.net_sales, total: true },
    { label: "Other income", value: s.other_income, href: lines({ group: "OTHER_INCOME" }) },
    { label: "Marketplace fees", value: s.marketplace_fees, href: lines({ group: "MARKETPLACE_FEES" }) },
    { label: "Fulfillment and storage", value: s.fulfillment, href: lines({ group: "FULFILLMENT" }) },
    { label: "Advertising", value: s.advertising, href: lines({ group: "ADVERTISING" }) },
    {
      label: "Other marketplace costs",
      value: s.other_marketplace_costs,
      href: lines({ group: "OTHER_MARKETPLACE_COSTS" }),
    },
    {
      label: "Non-recoverable VAT on fees",
      value: s.non_recoverable_vat,
      href: lines({ category: "INPUT_VAT" }),
      hidden: s.input_vat_treatment !== "NON_RECOVERABLE",
    },
  ]

  return (
    <div className="grid gap-6">
      {/* ---- what is still open ------------------------------------------ */}
      {incomplete && (
        <section role="status" className="rounded-xl border border-warning/40 bg-warning-subtle px-5 py-4">
          <div className="flex gap-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning-strong" aria-hidden />
            <div className="grid gap-2 text-sm">
              <p className="font-medium">Some figures for {month.label} are not final yet</p>
              <ul className="grid gap-1.5">
                {reasons.includes("VAT_TREATMENT_UNKNOWN") && (
                  <li>
                    VAT treatment unknown: {money(unsignedAmount(s.input_vat_unresolved))} of VAT
                    charged on fees is not counted either way, so contribution has no final
                    figure.{" "}
                    {isOwner ? (
                      <Link href="/marketplaces" className="font-medium underline underline-offset-4">
                        Set VAT on fees
                      </Link>
                    ) : (
                      "Ask the owner to set VAT on fees."
                    )}
                  </li>
                )}
                {reasons.includes("UNKNOWN_LINES") && (
                  <li>
                    {formatNumber(s.unknown_lines)} line{s.unknown_lines === 1 ? " uses" : "s use"} a
                    code BizMind does not recognise yet ({money(s.unknown_amount)}), so every figure is
                    incomplete.{" "}
                    <Link href="/ledger/quality" className="font-medium underline underline-offset-4">
                      Review in data quality
                    </Link>
                  </li>
                )}
                {reasons.includes("ROW_ERRORS") && (
                  <li>
                    {formatNumber(s.row_errors)} row{s.row_errors === 1 ? "" : "s"} in these files could
                    not be read.{" "}
                    <Link href="/imports" className="font-medium underline underline-offset-4">
                      See the files
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </section>
      )}

      {s.review_lines > 0 && (
        <section className="flex gap-3 rounded-xl border border-info/40 bg-info-subtle px-5 py-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-info-strong" aria-hidden />
          <p>
            {formatNumber(s.review_lines)} line{s.review_lines === 1 ? " is" : "s are"} counted with a
            medium-confidence rule ({money(s.review_amount)}).{" "}
            <Link href={lines({ view: "review" })} className="font-medium underline underline-offset-4">
              Check them
            </Link>
          </p>
        </section>
      )}

      {/* ---- the headline figures ---------------------------------------- */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <FigureCard label="Gross sales" value={money(s.gross_sales)} status={figures} href={lines({ group: "GROSS_SALES" })} />
        <FigureCard
          label="Net sales"
          value={money(s.net_sales)}
          status={figures}
          note="After refunds and seller-funded discounts"
        />
        <FigureCard label="Marketplace fees" value={money(s.marketplace_fees)} status={figures} href={lines({ group: "MARKETPLACE_FEES" })} />
        <FigureCard label="Fulfillment and storage" value={money(s.fulfillment)} status={figures} href={lines({ group: "FULFILLMENT" })} />
        <FigureCard label="Advertising" value={money(s.advertising)} status={figures} href={lines({ group: "ADVERTISING" })} />
        <FigureCard
          label="Contribution"
          value={s.contribution === null ? "Incomplete" : money(s.contribution)}
          status={s.contribution_status}
          emphasis
          href={lines({ view: "profit" })}
          note={
            s.contribution === null
              ? `${onlyVatOpen ? "Contribution before fee-VAT treatment" : "From recognised lines only"}: ${money(
                  s.contribution_before_open_items
                )} — not final`
              : "Before product costs and operating expenses"
          }
        />
      </section>

      {/* ---- the statement ----------------------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">{month.label}, line by line</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Amounts as the marketplace reported them, signed from your side: money in is positive,
            fees and refunds are negative.
          </p>
        </div>
        <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
          <Table>
            <TableBody>
              {statement
                .filter((row) => !row.hidden)
                .map((row) => (
                  <TableRow key={row.label} className={row.total ? "bg-muted/40" : undefined}>
                    <TableCell className={row.total ? "text-sm font-semibold" : "text-sm"}>{row.label}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">{money(row.value)}</TableCell>
                    <TableCell className="w-28 text-right">
                      {row.href && (
                        <Link href={row.href} className="text-xs font-medium underline-offset-4 hover:underline">
                          Lines
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              <TableRow className="bg-muted/40">
                <TableCell className="text-sm font-semibold">
                  Contribution
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    Before product costs and operating expenses
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-sm font-semibold tabular-nums">
                  {s.contribution === null ? (
                    <span className="inline-flex items-center gap-1 font-sans text-xs text-warning-strong">
                      <CircleAlert className="size-3.5" aria-hidden />
                      Incomplete
                    </span>
                  ) : (
                    money(s.contribution)
                  )}
                </TableCell>
                <TableCell className="w-28 text-right">
                  <Link href={lines({ view: "profit" })} className="text-xs font-medium underline-offset-4 hover:underline">
                    Lines
                  </Link>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>

      {/* ---- tax, apart from profit -------------------------------------- */}
      <section className="rounded-xl border border-border bg-card px-5 py-4">
        <h2 className="text-sm font-semibold">VAT, kept apart from profit</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          VAT on fees for this account: <span className="font-medium text-foreground">{INPUT_VAT_TREATMENT_LABEL[s.input_vat_treatment]}</span>.
          {" "}Recoverable VAT stays on the tax side; non-recoverable VAT is shown above as a cost.
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TaxFigure label="Input VAT on fees, recoverable" value={money(s.input_vat_recoverable)} />
          <TaxFigure label="Input VAT on fees, setting unknown" value={money(s.input_vat_unresolved)} />
          <TaxFigure label="Output VAT on sales" value={money(s.output_vat)} />
        </dl>
        <Link href={lines({ category: "INPUT_VAT" })} className="mt-3 inline-block text-xs font-medium underline-offset-4 hover:underline">
          See the VAT lines
        </Link>
      </section>

      {/* ---- the breakdown ----------------------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Where every line went</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each marketplace code is classified automatically. Nothing is left out: lines BizMind
            does not recognise are listed with their amount.
          </p>
        </div>
        <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Line</TableHead>
                <TableHead>Counts as</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.breakdown.map((row) => {
                const unknown = row.classification_status === "UNKNOWN"
                const href = unknown
                  ? lines({ view: "unknown", key: row.match_key })
                  : lines({ category: row.category, subcategory: row.subcategory })
                return (
                  <TableRow key={`${row.category}-${row.subcategory}-${row.match_key}-${row.classification_status}`}>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.financial_type ? FINANCIAL_TYPE_LABEL[row.financial_type] : "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {unknown ? (
                        <span className="inline-flex items-center gap-1 text-warning-strong">
                          <CircleAlert className="size-3.5" aria-hidden />
                          {CLASSIFICATION_STATUS_LABEL.UNKNOWN}
                        </span>
                      ) : (
                        row.category_label
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      <Link href={href} className="underline-offset-4 hover:underline">
                        {unknown ? <span className="font-mono text-xs">{row.match_key}</span> : row.subcategory}
                      </Link>
                      {row.classification_status === "UNDER_REVIEW" && (
                        <span className="ml-2 text-[11px] text-info-strong">Under review</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.pnl_treatment ? TREATMENT_LABEL[row.pnl_treatment] : "Nothing yet"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{formatNumber(row.lines)}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">{money(row.total)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* ---- what the marketplace reported ------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">What the marketplace reported</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each settlement touching {month.label}, with the total the marketplace stated beside the sum
            of its lines. A settlement often spans two months, so only part of it counts here. The
            payout is what the marketplace says it sent, not what reached your bank.
          </p>
        </div>
        {data.settlements.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">No settlement touches this month.</p>
        ) : (
          <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Settlement</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Reported total</TableHead>
                  <TableHead className="text-right">Sum of its lines</TableHead>
                  <TableHead>Check</TableHead>
                  <TableHead className="text-right">In {month.label}</TableHead>
                  <TableHead className="text-right">Payout reported</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.settlements.map((st) => (
                  <TableRow key={st.settlement_id}>
                    <TableCell className="text-xs">
                      <Link href={`/imports/${st.source_file_id}`} className="font-mono underline-offset-4 hover:underline">
                        {st.external_settlement_id}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatLedgerDay(st.period_start)} – {formatLedgerDay(st.period_end)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">{money(st.reported_total)}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">{money(st.lines_total)}</TableCell>
                    <TableCell>
                      {st.reconciles ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-success-strong">
                          <CircleCheck className="size-3.5" aria-hidden />
                          Adds up
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-danger-strong">
                          <CircleAlert className="size-3.5" aria-hidden />
                          Does not add up
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {money(st.lines_in_period)}
                      <span className="block text-[11px] text-muted-foreground">
                        {formatNumber(st.lines_in_period_count)} lines
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {money(st.payout_amount)}
                      <span className="block text-[11px] text-muted-foreground">{formatLedgerDay(st.payout_date)}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {data.quality.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {formatNumber(data.quality.length)} data quality item{data.quality.length === 1 ? "" : "s"} for this
          account and month.{" "}
          <Link href="/ledger/quality" className="font-medium text-foreground underline underline-offset-4">
            Open data quality
          </Link>
        </p>
      )}
    </div>
  )
}

function TaxFigure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function EmptyState({ title, body, href, action }: { title: string; body: string; href: string; action: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center">
      <p className="font-heading text-lg font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
      <Button asChild size="sm" variant="outline" className="mt-4 rounded-4xl">
        <Link href={href}>{action}</Link>
      </Button>
    </div>
  )
}
