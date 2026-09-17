import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowLeft, CircleAlert } from "lucide-react"

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
import { firstParam, ledgerHref, type SearchParams } from "@/features/ledger/params"
import {
  LINES_PAGE_SIZE,
  listLedgerAccounts,
  listLedgerLines,
  type LedgerLineFilter,
} from "@/features/ledger/queries"
import { formatMoney, formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import {
  CLASSIFICATION_CATEGORIES,
  METRIC_GROUPS,
  type MetricGroup,
} from "@/services/classification/model"
import { CLASSIFICATION_STATUS_LABEL, formatLedgerDay } from "@/services/ledger/display"
import { parseLedgerMonth } from "@/services/ledger/period"

export const metadata: Metadata = {
  title: "Ledger lines",
}

/**
 * The lines behind a figure.
 *
 * Every figure on the dashboard links here with the same account, month and
 * filter the engine used, so an owner can check any number line by line
 * against the marketplace's report. Paged in the database.
 */

const GROUP_LABEL: Record<MetricGroup, string> = {
  GROSS_SALES: "Gross sales",
  SALES_REFUNDS: "Sales refunds and returns",
  SELLER_DISCOUNTS: "Seller-funded discounts",
  OTHER_INCOME: "Other income",
  MARKETPLACE_FEES: "Marketplace fees",
  FULFILLMENT: "Fulfillment and storage",
  ADVERTISING: "Advertising",
  OTHER_MARKETPLACE_COSTS: "Other marketplace costs",
  INPUT_VAT: "Input VAT",
  OUTPUT_VAT: "Output VAT",
  CASH: "Cash",
  MEMO: "Memo",
}

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CLASSIFICATION_CATEGORIES.map((c) => [c.code, c.label])
)

function filterFrom(searchParams: SearchParams): { filter: LedgerLineFilter; title: string; params: Record<string, string> } {
  const group = firstParam(searchParams.group)
  if (group && (METRIC_GROUPS as readonly string[]).includes(group)) {
    return { filter: { kind: "group", group: group as MetricGroup }, title: GROUP_LABEL[group as MetricGroup], params: { group } }
  }

  const category = firstParam(searchParams.category)
  if (category && CATEGORY_LABEL[category]) {
    const subcategory = firstParam(searchParams.subcategory) ?? null
    return {
      filter: { kind: "category", category, subcategory },
      title: subcategory ? `${CATEGORY_LABEL[category]} · ${subcategory}` : CATEGORY_LABEL[category],
      params: subcategory ? { category, subcategory } : { category },
    }
  }

  switch (firstParam(searchParams.view)) {
    case "profit":
      return { filter: { kind: "profit" }, title: "Lines counted in contribution", params: { view: "profit" } }
    case "review":
      return { filter: { kind: "review" }, title: "Lines under review", params: { view: "review" } }
    case "vat":
      return { filter: { kind: "vat-unresolved" }, title: "VAT waiting for the account's setting", params: { view: "vat" } }
    case "unknown": {
      const key = firstParam(searchParams.key) ?? null
      return {
        filter: { kind: "unknown", matchKey: key },
        title: "Lines BizMind does not recognise",
        params: key ? { view: "unknown", key } : { view: "unknown" },
      }
    }
    default:
      return { filter: { kind: "all" }, title: "All lines", params: {} }
  }
}

export default async function LedgerLinesPage(props: PageProps<"/ledger/lines">) {
  const searchParams = await props.searchParams

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const accounts = await listLedgerAccounts(activeBusiness.id)
  const account = accounts.find((a) => a.id === firstParam(searchParams.account))
  const month = parseLedgerMonth(firstParam(searchParams.month))
  if (!account || !month) redirect("/ledger")

  const { filter, title, params } = filterFrom(searchParams)
  const requestedPage = Number.parseInt(firstParam(searchParams.page) ?? "0", 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0

  const supabase = await createClient()
  const [{ data: profile }, { rows, total }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listLedgerLines(account.id, month, filter, page),
  ])

  const base = { account: account.id, month: month.key, ...params }
  const shownFrom = total === 0 ? 0 : page * LINES_PAGE_SIZE + 1
  const shownTo = page * LINES_PAGE_SIZE + rows.length

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-6xl">
        <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 rounded-4xl">
          <Link href={ledgerHref("/ledger", { account: account.id, month: month.key })}>
            <ArrowLeft className="size-4" aria-hidden />
            Back to {month.label}
          </Link>
        </Button>

        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {account.label} · {month.label} (UTC, by posted date) · {formatNumber(total)} line
          {total === 1 ? "" : "s"}
        </p>

        <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
          {rows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">No lines match.</p>
          ) : (
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Posted</TableHead>
                    <TableHead>Marketplace code</TableHead>
                    <TableHead>Classified as</TableHead>
                    <TableHead>Order · SKU</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>File</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        {formatLedgerDay(line.posted_at)}
                      </TableCell>
                      <TableCell className="max-w-72 text-xs">
                        <span className="block truncate">
                          {[line.source_type, line.source_subtype, line.source_description].filter(Boolean).join(" · ")}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {line.classification_status === "UNKNOWN" ? (
                          <span className="inline-flex items-center gap-1 text-warning-strong">
                            <CircleAlert className="size-3.5" aria-hidden />
                            {CLASSIFICATION_STATUS_LABEL.UNKNOWN}
                          </span>
                        ) : (
                          <>
                            {line.category_label} · {line.subcategory}
                            {line.classification_status === "UNDER_REVIEW" && (
                              <span className="ml-1 text-info-strong">(under review)</span>
                            )}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="max-w-48 truncate font-mono text-[11px] text-muted-foreground">
                        {[line.order_ref, line.raw_sku].filter(Boolean).join(" · ") || "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">
                        {formatMoney(line.amount, line.currency)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <Link href={`/imports/${line.source_file_id}`} className="underline-offset-4 hover:underline">
                          Open
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {total > 0 && (
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing {formatNumber(shownFrom)}–{formatNumber(shownTo)} of {formatNumber(total)}
            </span>
            <div className="flex gap-2">
              {page > 0 && (
                <Button asChild size="sm" variant="outline" className="rounded-4xl">
                  <Link href={ledgerHref("/ledger/lines", { ...base, page: page - 1 })}>Previous</Link>
                </Button>
              )}
              {shownTo < total && (
                <Button asChild size="sm" variant="outline" className="rounded-4xl">
                  <Link href={ledgerHref("/ledger/lines", { ...base, page: page + 1 })}>Next</Link>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  )
}
