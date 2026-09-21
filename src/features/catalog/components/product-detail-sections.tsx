import { Sparkles } from "lucide-react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ProductCostForm } from "@/features/catalog/components/product-cost-form"
import { ProductForm } from "@/features/catalog/components/product-form"
import { RowActionButton } from "@/features/catalog/components/row-action-button"
import { UnmatchButton } from "@/features/catalog/components/unmatch-button"
import type { ProductDetail } from "@/features/catalog/queries"
import { formatMoney } from "@/lib/format"
import { MARKETPLACE_NAMES } from "@/services/catalog/sku-setup"
import { formatLedgerDay } from "@/services/ledger/display"

const METHOD_LABEL = {
  MANUAL: "Matched by you",
  EXCEL: "Matched in a setup sheet",
  AUTOMATIC: "Matched automatically",
} as const

/**
 * One product: its dated costs (never edited -- a wrong cost is withdrawn and
 * a new one added), its marketplace SKUs and its details. Shown in the side
 * panel on Products and costs, and on the product's own page.
 */
export function ProductDetailSections({
  detail,
  currencies,
  canManage,
  compact = false,
}: {
  detail: ProductDetail
  currencies: string[]
  canManage: boolean
  /** In the side panel: narrower spacing, no outer cards. */
  compact?: boolean
}) {
  const { product, costs, skus } = detail
  const confirmed = skus.filter((s) => s.status === "CONFIRMED")
  const rejected = skus.filter((s) => s.status === "REJECTED")
  const pad = compact ? "px-4" : "px-5"
  const cells = compact
    ? "[&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4"
    : "[&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5"

  return (
    <div className="grid gap-5">
      {/* ---- costs ------------------------------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className={`border-b border-border ${pad} py-3`}>
          <h3 className="text-sm font-semibold">Cost history</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Each sale uses the latest cost that started on or before its date, in its currency. Costs are never
            changed: a new cost starts from its own date.
          </p>
        </div>
        {costs.length === 0 ? (
          <p className={`${pad} py-5 text-sm text-muted-foreground`}>
            No cost yet: sales of this product keep gross profit incomplete.
          </p>
        ) : (
          <div className={`overflow-x-auto ${cells}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Applies from</TableHead>
                  <TableHead className="text-right">Cost per unit</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage && <TableHead className="text-right">Action</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {costs.map((c) => (
                  <TableRow key={c.id} className={c.retired_at ? "text-muted-foreground" : undefined}>
                    <TableCell className="text-sm">
                      {formatLedgerDay(c.effective_from)}
                      {c.note && <span className="block text-[11px] text-muted-foreground">{c.note}</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {c.retired_at ? <s>{formatMoney(c.unit_cost, c.currency)}</s> : formatMoney(c.unit_cost, c.currency)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.retired_at
                        ? `Withdrawn ${formatLedgerDay(c.retired_at)}${c.retire_reason ? `: ${c.retire_reason}` : ""}`
                        : "In use"}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        {!c.retired_at && <RowActionButton kind="retire-cost" id={c.id} />}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {canManage && <ProductCostForm productId={product.id} currencies={currencies} />}

      {/* ---- SKUs -------------------------------------------------------- */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className={`border-b border-border ${pad} py-3`}>
          <h3 className="text-sm font-semibold">Marketplace SKUs</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Sales under these SKUs count as this product in every month, past and future.
          </p>
        </div>
        {skus.length === 0 ? (
          <p className={`${pad} py-5 text-sm text-muted-foreground`}>No SKUs matched yet.</p>
        ) : (
          <div className={`overflow-x-auto ${cells}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>How</TableHead>
                  {canManage && <TableHead className="text-right">Action</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...confirmed, ...rejected].map((s) => (
                  <TableRow key={s.id} className={s.status === "REJECTED" ? "text-muted-foreground" : undefined}>
                    <TableCell>
                      <span className="block break-all font-mono text-xs">{s.raw_sku}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {MARKETPLACE_NAMES[s.marketplace_code] ?? s.marketplace_code}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {s.status === "REJECTED" ? (
                        "Not this product"
                      ) : s.method === "AUTOMATIC" ? (
                        <span className="inline-flex items-center gap-1 text-info-strong">
                          <Sparkles className="size-3.5" aria-hidden />
                          {METHOD_LABEL.AUTOMATIC}
                        </span>
                      ) : (
                        METHOD_LABEL[s.method]
                      )}
                      <span className="block text-[11px] text-muted-foreground">{formatLedgerDay(s.decided_at)}</span>
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        {s.status === "CONFIRMED" ? (
                          <UnmatchButton
                            marketplaceCode={s.marketplace_code}
                            rawSku={s.raw_sku}
                            productId={product.id}
                            automatic={s.method === "AUTOMATIC"}
                          />
                        ) : (
                          <RowActionButton kind="remove-match" id={s.id} />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {canManage && <ProductForm product={product} />}
    </div>
  )
}
