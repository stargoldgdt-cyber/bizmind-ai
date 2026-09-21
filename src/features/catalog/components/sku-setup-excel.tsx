"use client"

import { useRouter } from "next/navigation"
import { useRef, useState, useTransition } from "react"
import { CircleAlert, CircleCheck, Download, FileSpreadsheet, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  applySkuSetupAction,
  previewSkuSetupAction,
  type SkuSetupPreview,
  type SkuSetupResult,
} from "@/features/catalog/setup-actions"

/**
 * Bulk SKU setup with ONE Excel sheet (migration 0045): download the SKUs
 * that need a product, fill Product SKU (and optionally the cost), upload,
 * check, apply. Nothing is applied until the seller has seen every problem
 * with its row number; rows that disagree are left out and named.
 */
export function SkuSetupExcel({ needAttention }: { needAttention: number }) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SkuSetupPreview | null>(null)
  const [result, setResult] = useState<SkuSetupResult | null>(null)

  const check = (file: File) =>
    startTransition(async () => {
      setError(null)
      setResult(null)
      setPreview(null)
      const form = new FormData()
      form.set("file", file)
      const reply = await previewSkuSetupAction(form)
      if (!reply.ok) setError(reply.error)
      else setPreview(reply)
    })

  const apply = () =>
    startTransition(async () => {
      if (!preview) return
      setError(null)
      const reply = await applySkuSetupAction(preview.rows)
      if (!reply.ok) {
        setError(reply.error)
        return
      }
      setResult(reply.result)
      setPreview(null)
      if (input.current) input.current.value = ""
      router.refresh()
    })

  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4" aria-busy={pending}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose-comfortable">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileSpreadsheet className="size-4 text-primary" aria-hidden />
            Many SKUs? Set them up in one Excel sheet
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Download the sheet, fill in <span className="font-medium text-foreground">Product SKU</span> and, if you
            know it, <span className="font-medium text-foreground">COGS / Unit</span>. Several marketplace SKUs can
            share one Product SKU; they then share its cost. Upload it back and BizMind remembers every match.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline" className="rounded-4xl">
            <a href="/api/v1/catalog/sku-setup">
              <Download className="size-4" aria-hidden />
              {needAttention > 0 ? `Download ${needAttention.toLocaleString("en-US")} SKUs to set up` : "Download sheet"}
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="rounded-4xl">
            <a href="/api/v1/catalog/sku-setup?scope=all">All SKUs (for corrections)</a>
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          accept=".xlsx"
          aria-label="Filled SKU setup sheet"
          className="max-w-full text-sm file:mr-3 file:rounded-full file:border file:border-border file:bg-card file:px-3 file:py-1 file:text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) check(file)
          }}
        />
        {pending && <p className="text-xs text-muted-foreground">Checking…</p>}
      </div>

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-danger-strong">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {preview && (
        <div className="mt-4 grid gap-3 rounded-lg border border-border p-4 text-sm">
          <p className="inline-flex items-center gap-2 font-medium">
            <CircleCheck className="size-4 text-success-strong" aria-hidden />
            {preview.rows.length.toLocaleString("en-US")} row{preview.rows.length === 1 ? "" : "s"} ready, for{" "}
            {preview.products.toLocaleString("en-US")} product{preview.products === 1 ? "" : "s"}
          </p>
          {preview.leftBlank > 0 && (
            <p className="text-muted-foreground">
              {preview.leftBlank.toLocaleString("en-US")} row{preview.leftBlank === 1 ? " was" : "s were"} left blank; they
              stay in Needs attention.
            </p>
          )}
          {preview.issues.length > 0 && (
            <div>
              <p className="inline-flex items-center gap-2 font-medium text-warning-strong">
                <CircleAlert className="size-4" aria-hidden />
                {preview.issues.length.toLocaleString("en-US")} row{preview.issues.length === 1 ? "" : "s"} left out
              </p>
              <ul className="mt-2 grid max-h-64 gap-1 overflow-y-auto text-xs">
                {preview.issues.map((issue, index) => (
                  <li key={`${issue.rowNumber}-${index}`}>
                    <span className="font-mono">Row {issue.rowNumber}</span>: {issue.message}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Fix them in the sheet and upload it again, or apply the ready rows now and fix the rest later.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="rounded-4xl" disabled={pending || preview.rows.length === 0} onClick={apply}>
              <Upload className="size-4" aria-hidden />
              Apply {preview.rows.length.toLocaleString("en-US")} row{preview.rows.length === 1 ? "" : "s"}
            </Button>
            <Button size="sm" variant="ghost" className="rounded-4xl" disabled={pending} onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {result && (
        <div role="status" className="mt-4 rounded-lg border border-success/35 bg-success-subtle p-4 text-sm">
          <p className="inline-flex items-center gap-2 font-medium text-success-strong">
            <CircleCheck className="size-4" aria-hidden />
            Setup applied. BizMind will remember these for every future report.
          </p>
          <ul className="mt-2 grid gap-0.5 text-xs">
            <li>{result.skus_matched.toLocaleString("en-US")} SKUs matched, {result.skus_changed.toLocaleString("en-US")} corrected, {result.skus_unchanged.toLocaleString("en-US")} already right</li>
            <li>{result.products_created.toLocaleString("en-US")} new products</li>
            <li>
              {result.costs_added.toLocaleString("en-US")} costs added ({result.costs_backfilled.toLocaleString("en-US")} from each
              product&apos;s first sale), {result.costs_unchanged.toLocaleString("en-US")} unchanged
            </li>
            {result.matched_automatically > 0 && (
              <li>{result.matched_automatically.toLocaleString("en-US")} more SKUs matched automatically (identical SKUs)</li>
            )}
          </ul>
        </div>
      )}
    </section>
  )
}
