import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { CircleAlert, CircleCheck } from "lucide-react"
import { z } from "zod"

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
import { NeedsAttentionRow } from "@/features/catalog/components/needs-attention-row"
import { ProductDetailSections } from "@/features/catalog/components/product-detail-sections"
import { ProductForm } from "@/features/catalog/components/product-form"
import { ProductPanel } from "@/features/catalog/components/product-panel"
import { SkuSetupExcel } from "@/features/catalog/components/sku-setup-excel"
import {
  getProductCostGapQueue,
  getProductDetail,
  getSkuQueue,
  getSkuSummary,
  listActiveProducts,
  listBusinessCurrencies,
  listProductOverview,
} from "@/features/catalog/queries"
import { firstParam, ledgerHref } from "@/features/ledger/params"
import { formatMoney, formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { MARKETPLACE_NAMES } from "@/services/catalog/sku-setup"
import { formatLedgerDay } from "@/services/ledger/display"

export const metadata: Metadata = {
  title: "Products and costs",
}

/** Needs attention shows this many SKUs, or up to MORE on "Show more". */
const FIRST_PAGE = 20
const MORE = 200
/** The cost-gap list is business-wide already; cap what renders on this page. */
const COST_GAP_PREVIEW = 50

/**
 * Products and costs: the one place to set up marketplace SKUs, products and
 * their costs (migration 0045).
 *
 * SET UP ONCE, BIZMIND REMEMBERS. A SKU matched to a product (inline, in the
 * Excel sheet, or automatically when identical to a known SKU) is recognised
 * in every past and future report, and the product's dated cost applies to
 * it. Only SKUs with no product appear in Needs attention. An unmatched SKU
 * never stops marketplace profit; only gross profit waits for it.
 *
 * "Need your input: 0" is about SKU MAPPING only -- it says nothing about
 * whether a matched product actually has a cost. Those are genuinely
 * different questions, and showing only the mapping count next to a products
 * table that separately flags "No cost" was confusing on its own page (owner
 * report, 2026-09-28): a brand-new product can be fully matched and still
 * have zero cost, if the sheet that created it left the cost cell blank.
 * product_cost_gap_queue() (migration 0055, already built for Marketplace
 * data quality) surfaces exactly that, reused here -- no new backend.
 *
 * Nothing is calculated here: counts of SKUs only, figures from SQL.
 */
export default async function CatalogPage(props: PageProps<"/catalog">) {
  const searchParams = await props.searchParams
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const requestedProduct = firstParam(searchParams.product)
  const productId = requestedProduct && z.string().uuid().safeParse(requestedProduct).success ? requestedProduct : null
  const showAll = firstParam(searchParams.all) === "1"

  const supabase = await createClient()
  const [{ data: profile }, products, shown, summary, choices, currencies, detail, costGaps] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listProductOverview(activeBusiness.id),
    // Only the rows on screen are read; the counts come from the summary.
    getSkuQueue(activeBusiness.id, showAll ? MORE : FIRST_PAGE),
    getSkuSummary(activeBusiness.id),
    listActiveProducts(activeBusiness.id),
    listBusinessCurrencies(activeBusiness.id),
    productId ? getProductDetail(activeBusiness.id, productId) : Promise.resolve(null),
    getProductCostGapQueue(activeBusiness.id, COST_GAP_PREVIEW),
  ])
  const canManage = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"
  const waiting = summary.needAttention

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-6xl gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Products and costs</h1>
          <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
            Match each marketplace SKU to your product once and give the product its cost. BizMind remembers it
            for every future report, so only new SKUs ever need your attention.
          </p>
        </div>

        {/* ---- where setup stands ------------------------------------------ */}
        {summary.skus > 0 && (
          <section aria-label="SKU setup" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Marketplace SKUs in your files" value={formatNumber(summary.skus)} />
            <Stat
              label="Recognised"
              value={formatNumber(summary.recognised)}
              icon={<CircleCheck className="size-4 text-success-strong" aria-hidden />}
              note={
                summary.matchedAutomatically > 0
                  ? `${formatNumber(summary.matchedAutomatically)} matched automatically (identical SKUs)`
                  : "Costs apply to these automatically"
              }
            />
            <Stat
              label="Need your input"
              value={formatNumber(summary.needAttention)}
              icon={
                summary.needAttention > 0 ? (
                  <CircleAlert className="size-4 text-warning-strong" aria-hidden />
                ) : (
                  <CircleCheck className="size-4 text-success-strong" aria-hidden />
                )
              }
              note={
                summary.needAttention > 0
                  ? "Marketplace profit is complete; only gross profit waits for these"
                  : "Every SKU is matched to a product"
              }
            />
            <Stat
              label="Products with no cost"
              value={formatNumber(costGaps.length)}
              icon={
                costGaps.length > 0 ? (
                  <CircleAlert className="size-4 text-warning-strong" aria-hidden />
                ) : (
                  <CircleCheck className="size-4 text-success-strong" aria-hidden />
                )
              }
              note={
                costGaps.length > 0
                  ? "Matched, but gross profit waits for these too"
                  : "Every matched product has a cost"
              }
            />
          </section>
        )}

        {/* ---- needs attention -------------------------------------------- */}
        <section id="needs-attention" className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">
              {waiting === 0
                ? "Needs attention"
                : `${formatNumber(waiting)} SKU${waiting === 1 ? " needs" : "s need"} product mapping`}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {waiting === 0
                ? "Every SKU in your marketplace files is matched to a product."
                : "Largest sales first. Save & Match remembers the SKU for good; the cost is saved on the product."}
              {waiting > 0 && !canManage && " Only an owner or admin can match SKUs."}
            </p>
          </div>

          {waiting === 0 ? (
            <p className="flex items-center gap-2 px-5 py-5 text-sm">
              <CircleCheck className="size-4 text-success-strong" aria-hidden />
              Nothing needs your attention. New SKUs from future reports will appear here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {shown.map((row) => {
                const single = !row.currencies.includes(",")
                return (
                  <li
                    key={`${row.marketplace_code}-${row.raw_sku}`}
                    className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
                  >
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {MARKETPLACE_NAMES[row.marketplace_code] ?? row.marketplace_code} · {row.accounts}
                      </p>
                      <p className="mt-1 break-all font-mono text-sm font-semibold">{row.raw_sku}</p>
                      {row.sample_title && <p className="mt-1 text-sm">{row.sample_title}</p>}
                      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <dt className="text-muted-foreground">Units sold</dt>
                          <dd className="font-mono tabular-nums">{formatNumber(row.units_sold, 4)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Net sales</dt>
                          <dd className="font-mono tabular-nums">
                            {single ? formatMoney(row.net_sales, row.currencies) : "Several currencies"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Seen</dt>
                          <dd>
                            {formatLedgerDay(row.first_seen)} – {formatLedgerDay(row.last_seen)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    {canManage ? (
                      <NeedsAttentionRow
                        marketplaceCode={row.marketplace_code}
                        rawSku={row.raw_sku}
                        title={row.sample_title}
                        currencies={row.currencies}
                        suggestions={row.suggestions}
                        products={choices}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {row.suggestions.length > 0
                          ? `Suggested: ${row.suggestions.map((s) => s.name).join(", ")}`
                          : "No suggestion."}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {waiting > shown.length && (
            <div className="border-t border-border px-5 py-3 text-sm">
              {!showAll && (
                <Link href="/catalog?all=1#needs-attention" className="font-medium underline underline-offset-4">
                  Show {formatNumber(Math.min(waiting, MORE))}
                </Link>
              )}
              <span className="text-muted-foreground">
                {showAll ? `Showing the ${formatNumber(shown.length)} largest of ${formatNumber(waiting)}.` : ""} With this many,
                the Excel sheet below is quickest: it lists every one.
              </span>
            </div>
          )}
        </section>

        {/* ---- products with no cost (0055's reader, shown here too) ------- */}
        {costGaps.length > 0 && (
          <section id="cost-gaps" className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold">
                {formatNumber(costGaps.length)}
                {costGaps.length === COST_GAP_PREVIEW ? "+" : ""} product{costGaps.length === 1 ? "" : "s"} matched, but
                with no cost
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Every marketplace SKU below is already matched to one of your products -- that part is done. Gross
                profit still waits on these because the product itself has no cost in this currency for the sale
                date. Largest sales first.
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
                          href={ledgerHref("/catalog", { product: row.product_id })}
                          scroll={false}
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
          </section>
        )}

        {canManage && summary.skus > 0 && <SkuSetupExcel needAttention={waiting} />}

        {/* ---- products ----------------------------------------------------- */}
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">Your products</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Open a product to see its cost history, add a dated cost, or check its marketplace SKUs.
            </p>
          </div>
          {products.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No products yet. Create them from your SKUs above, with the Excel sheet, or add one below.
            </p>
          ) : (
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Product SKU</TableHead>
                    <TableHead className="text-right">Marketplace SKUs</TableHead>
                    <TableHead className="text-right">Cost today</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.map((p) => (
                    <TableRow key={p.product_id} className={p.product_id === productId ? "bg-primary/5" : undefined}>
                      <TableCell className="text-sm">
                        <Link
                          href={ledgerHref("/catalog", { product: p.product_id })}
                          scroll={false}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {p.name}
                        </Link>
                        {p.status === "ARCHIVED" && <span className="ml-2 text-[11px] text-muted-foreground">Archived</span>}
                        {(p.category || p.brand) && (
                          <span className="block text-[11px] text-muted-foreground">
                            {[p.category, p.brand].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{p.sku_code ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">{formatNumber(p.mapped_skus)}</TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">
                        {p.current_costs.length === 0 ? (
                          <span className="inline-flex items-center gap-1 font-sans text-xs text-warning-strong">
                            <CircleAlert className="size-3.5" aria-hidden />
                            No cost
                          </span>
                        ) : (
                          p.current_costs.map((c) => (
                            <span key={c.currency} className="block">
                              {formatMoney(c.unit_cost, c.currency)}
                              <span className="ml-1 font-sans text-[11px] text-muted-foreground">
                                since {formatLedgerDay(c.effective_from)}
                              </span>
                            </span>
                          ))
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {canManage ? (
          <ProductForm />
        ) : (
          <p className="text-sm text-muted-foreground">Only an owner or admin can add products and costs.</p>
        )}
      </div>

      {detail && (
        <ProductPanel
          productId={detail.product.id}
          title={detail.product.name}
          description={
            [detail.product.sku_code, detail.product.category, detail.product.brand].filter(Boolean).join(" · ") ||
            "No Product SKU, category or brand"
          }
        >
          <ProductDetailSections detail={detail} currencies={currencies} canManage={canManage} compact />
        </ProductPanel>
      )}
    </AppShell>
  )
}

function Stat({
  label,
  value,
  note,
  icon,
}: {
  label: string
  value: string
  note?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 flex items-center gap-2 font-mono text-2xl font-semibold tabular-nums">
        {icon}
        {value}
      </p>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}
