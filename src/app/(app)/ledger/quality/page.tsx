import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { CircleCheck } from "lucide-react"

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
import { getProductCostGapQueue, getSkuQueue, getSkuSummary } from "@/features/catalog/queries"
import { ClassifyCodeDialog } from "@/features/ledger/components/classify-code-dialog"
import { RetireClassificationButton } from "@/features/ledger/components/retire-classification-button"
import {
  getBusinessDataQuality,
  listBusinessClassifications,
  listCategories,
} from "@/features/ledger/queries"
import { formatMoney, formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { FINANCIAL_TYPE_LABEL, formatLedgerDay } from "@/services/ledger/display"
import type { LedgerQualityRow } from "@/services/ledger/export"

export const metadata: Metadata = {
  title: "Marketplace data quality",
}

/** The full lists live on Products and costs; this page shows a first screen of each. */
const QUEUE_PREVIEW = 50

/**
 * Marketplace data quality: the exception path.
 *
 * Known marketplace lines are classified automatically and never appear here.
 * This page lists only what keeps a figure from being final -- an unrecognised
 * code, a VAT setting not yet chosen, a settlement that does not add up, a row
 * that could not be read, a SKU not yet matched to a product, a product with
 * no cost on the sale date -- and what to do about each. Everything is
 * computed on request, so fixing the cause closes the item by itself.
 *
 * The SKU and cost sections (migration 0055) read the exact same functions
 * Products and costs and Marketplace P&L already use (sku_mapping_queue,
 * product_cost_gap_queue) -- never a second, possibly-disagreeing count.
 * They are deliberately NOT folded into ledger_data_quality(): that function
 * also feeds the executive dashboard's own, separate unmatched-SKU and
 * missing-cost findings, and counting the same issue in two places there
 * would be confusing, not clarifying.
 */

const SECTIONS: { kind: LedgerQualityRow["issue_kind"]; title: string }[] = [
  { kind: "UNKNOWN_CODE", title: "Codes BizMind does not recognise yet" },
  { kind: "VAT_TREATMENT_UNKNOWN", title: "VAT on fees waiting for a setting" },
  { kind: "FEE_VAT_NOT_SEPARATED", title: "Fees that still include VAT" },
  { kind: "SETTLEMENT_MISMATCH", title: "Settlements that do not add up" },
  { kind: "ROW_ERRORS", title: "Rows that could not be read" },
  { kind: "UNDER_REVIEW", title: "Lines counted with a medium-confidence rule" },
]

export default async function LedgerQualityPage() {
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, issues, classifications, categories, skuQueue, skuSummary, costGaps] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getBusinessDataQuality(activeBusiness.id),
    listBusinessClassifications(activeBusiness.id),
    listCategories(),
    getSkuQueue(activeBusiness.id, QUEUE_PREVIEW),
    getSkuSummary(activeBusiness.id),
    getProductCostGapQueue(activeBusiness.id, QUEUE_PREVIEW),
  ])

  const canClassify = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"
  const isOwner = activeBusiness.role === "OWNER"
  const categoryLabel = Object.fromEntries(categories.map((c) => [c.code, c.label]))
  const categoryOptions = categories.map((c) => ({
    code: c.code,
    label: c.label,
    financialType: c.financial_type,
  }))

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-6xl gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Marketplace data quality</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            Known marketplace lines are classified automatically. Only what keeps a figure from
            being final is listed here, with what to do about it.
          </p>
        </div>

        {issues.length === 0 && skuSummary.needAttention === 0 && costGaps.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-6 text-sm">
            <CircleCheck className="size-5 text-success-strong" aria-hidden />
            Nothing needs attention: every line is recognised, every SKU is matched to a product
            with a cost, and every settlement adds up.
          </div>
        ) : (
          <>
            {skuSummary.needAttention > 0 && (
              <section className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold">
                    SKUs not yet matched to a product ({formatNumber(skuSummary.needAttention)})
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Marketplace profit is complete; only gross profit waits for these. Largest sales first.
                  </p>
                </div>
                <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Marketplace</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead className="text-right">Units sold</TableHead>
                        <TableHead className="text-right">Net sales</TableHead>
                        <TableHead className="text-right">What to do</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {skuQueue.map((row) => (
                        <TableRow key={`${row.marketplace_code}-${row.raw_sku}`}>
                          <TableCell className="text-xs text-muted-foreground">{row.marketplace_code}</TableCell>
                          <TableCell className="max-w-80 truncate font-mono text-xs">{row.raw_sku}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {formatNumber(row.units_sold, 4)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {row.currencies.includes(",") ? "Several currencies" : formatMoney(row.net_sales, row.currencies)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Link
                              href="/catalog#needs-attention"
                              className="text-xs font-medium underline-offset-4 hover:underline"
                            >
                              Match it
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {skuSummary.needAttention > skuQueue.length && (
                  <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">
                    Showing the {formatNumber(skuQueue.length)} largest of {formatNumber(skuSummary.needAttention)}.{" "}
                    <Link href="/catalog#needs-attention" className="font-medium text-foreground underline underline-offset-4">
                      See every one
                    </Link>
                  </p>
                )}
              </section>
            )}

            {costGaps.length > 0 && (
              <section className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold">
                    Products with no cost on the sale date ({formatNumber(costGaps.length)}
                    {costGaps.length === QUEUE_PREVIEW ? "+" : ""})
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Matched to a product, but that product has no cost in this currency on the day it sold, so
                    gross profit is incomplete for it. Largest sales first.
                  </p>
                </div>
                <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead>Seen on</TableHead>
                        <TableHead className="text-right">Units sold</TableHead>
                        <TableHead className="text-right">Sales</TableHead>
                        <TableHead className="text-right">What to do</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {costGaps.map((row) => (
                        <TableRow key={`${row.product_id}-${row.currency}`}>
                          <TableCell className="text-sm">
                            {row.product_name}
                            {row.product_sku && (
                              <span className="block font-mono text-xs text-muted-foreground">{row.product_sku}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{row.accounts}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">
                            {formatNumber(row.units_sold, 4)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {formatMoney(row.sales_amount, row.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Link
                              href={`/catalog?product=${row.product_id}`}
                              className="text-xs font-medium underline-offset-4 hover:underline"
                            >
                              Add a cost
                            </Link>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {costGaps.length === QUEUE_PREVIEW && (
                  <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">
                    Showing the {formatNumber(QUEUE_PREVIEW)} largest.{" "}
                    <Link href="/catalog" className="font-medium text-foreground underline underline-offset-4">
                      See every product
                    </Link>
                  </p>
                )}
              </section>
            )}

            {SECTIONS.map(({ kind, title }) => {
            const rows = issues.filter((issue) => issue.issue_kind === kind)
            if (rows.length === 0) return null
            return (
              <section key={kind} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold">
                    {title} ({formatNumber(rows.length)})
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">{rows[0].detail}</p>
                </div>
                <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>
                          {kind === "SETTLEMENT_MISMATCH" ? "Settlement" : kind === "FEE_VAT_NOT_SEPARATED" ? "Month" : "Code"}
                        </TableHead>
                        <TableHead className="text-right">Lines</TableHead>
                        <TableHead className="text-right">
                          {kind === "SETTLEMENT_MISMATCH" ? "Difference" : "Amount"}
                        </TableHead>
                        <TableHead className="text-right">Files</TableHead>
                        <TableHead className="text-right">What to do</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow key={`${row.marketplace_account_id}-${row.reference}-${row.category}-${row.subcategory}`}>
                          <TableCell className="text-sm">{row.account_label}</TableCell>
                          <TableCell className="max-w-80 text-xs">
                            <span className="block truncate font-mono">{row.reference ?? "—"}</span>
                            {row.subcategory && (
                              <span className="block text-muted-foreground">Counted as {row.subcategory}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{formatNumber(row.lines)}</TableCell>
                          <TableCell className="text-right font-mono text-sm tabular-nums">
                            {formatMoney(row.amount, row.currency)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{formatNumber(row.files)}</TableCell>
                          <TableCell className="text-right">
                            <IssueAction
                              row={row}
                              canClassify={canClassify}
                              isOwner={isOwner}
                              categories={categoryOptions}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )
          })}
          </>
        )}

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">Codes your business classified</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              These apply to your business only. BizMind&apos;s own rules are never overridden.
              Undoing one makes the code unrecognised again.
            </p>
          </div>
          {classifications.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">None yet.</p>
          ) : (
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Classified as</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Since</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {classifications.map((rule) => (
                    <TableRow key={rule.id}>
                      <TableCell className="max-w-80 truncate font-mono text-xs">{rule.match_key}</TableCell>
                      <TableCell className="text-sm">
                        {categoryLabel[rule.category] ?? rule.category} · {rule.subcategory}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{rule.version}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatLedgerDay(rule.created_at)}</TableCell>
                      <TableCell className="text-right">
                        {canClassify && <RetireClassificationButton ruleId={rule.id} />}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <p className="text-xs text-muted-foreground">
          Categories available: {categories.map((c) => `${FINANCIAL_TYPE_LABEL[c.financial_type]} · ${c.label}`).join(", ")}.
        </p>
      </div>
    </AppShell>
  )
}

function IssueAction({
  row,
  canClassify,
  isOwner,
  categories,
}: {
  row: LedgerQualityRow
  canClassify: boolean
  isOwner: boolean
  categories: { code: string; label: string; financialType: string }[]
}) {
  switch (row.issue_kind) {
    case "UNKNOWN_CODE":
      return canClassify && row.format_id && row.reference ? (
        <ClassifyCodeDialog
          marketplaceCode={row.marketplace_code}
          formatId={row.format_id}
          matchKey={row.reference}
          categories={categories}
        />
      ) : (
        <span className="text-xs text-muted-foreground">An owner or admin can classify it</span>
      )
    case "VAT_TREATMENT_UNKNOWN":
      return isOwner ? (
        <Link href="/marketplaces" className="text-xs font-medium underline-offset-4 hover:underline">
          Set VAT on fees
        </Link>
      ) : (
        <span className="text-xs text-muted-foreground">The owner sets this</span>
      )
    case "FEE_VAT_NOT_SEPARATED":
      return (
        <Link href="/imports/settlement" className="text-xs font-medium underline-offset-4 hover:underline">
          Upload the VAT invoices
        </Link>
      )
    case "ROW_ERRORS":
    case "SETTLEMENT_MISMATCH":
      return (
        <Link href="/imports" className="text-xs font-medium underline-offset-4 hover:underline">
          See the files
        </Link>
      )
    default:
      return <span className="text-xs text-muted-foreground">Check against the report</span>
  }
}
