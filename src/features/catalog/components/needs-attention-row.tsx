"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Check, Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { decideSkuAction } from "@/features/catalog/actions"
import { saveAndMatchAction } from "@/features/catalog/setup-actions"
import { SUGGESTION_REASON_LABEL, type SuggestionReason } from "@/services/catalog/sku"

/**
 * One marketplace SKU that needs a product, set up in place: choose an
 * existing product (or create one), optionally give the unit cost, and
 * "Save & Match". The mapping is remembered for every past and future report,
 * and the cost is saved on the PRODUCT (first cost from its first sale; a
 * changed cost from today). Suggestions are only offered; a person confirms.
 */
export function NeedsAttentionRow({
  marketplaceCode,
  rawSku,
  title,
  currencies,
  suggestions,
  products,
}: {
  marketplaceCode: string
  rawSku: string
  title: string | null
  /** The SKU's account currencies, e.g. "AED" or "AED, SAR". */
  currencies: string
  suggestions: { product_id: string; name: string; reason: SuggestionReason }[]
  products: { id: string; name: string; sku_code: string | null }[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<"existing" | "new">(products.length === 0 ? "new" : "existing")
  const [productId, setProductId] = useState(suggestions[0]?.product_id ?? "")
  const [newSku, setNewSku] = useState("")
  const [newName, setNewName] = useState((title ?? "").slice(0, 200))
  const [unitCost, setUnitCost] = useState("")

  const singleCurrency = currencies.includes(",") ? null : currencies
  const id = `${marketplaceCode}-${rawSku}`.replace(/[^A-Za-z0-9-]/g, "_")

  const save = () =>
    startTransition(async () => {
      setError(null)
      const result = await saveAndMatchAction({
        marketplaceCode,
        rawSku,
        ...(mode === "existing" ? { productId } : { newProductSku: newSku, newProductName: newName }),
        unitCost: singleCurrency ? unitCost : "",
        currency: singleCurrency ?? undefined,
      })
      if (!result.ok) setError(result.error)
      else router.refresh()
    })

  const reject = (rejected: string) =>
    startTransition(async () => {
      setError(null)
      const result = await decideSkuAction({ marketplaceCode, rawSku, productId: rejected, decision: "REJECTED" })
      if (!result.ok) setError(result.error)
      else router.refresh()
    })

  const ready = mode === "existing" ? productId !== "" : newSku.trim() !== ""

  return (
    <div className="grid gap-3" aria-busy={pending}>
      {suggestions.map((s) => (
        <div
          key={`${s.product_id}-${s.reason}`}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-info/40 bg-info-subtle px-3 py-2 text-sm"
        >
          <p className="min-w-0 flex-1">
            <span className="font-medium">{s.name}</span>
            <span className="block text-[11px] text-muted-foreground">Suggested: {SUGGESTION_REASON_LABEL[s.reason]}</span>
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-4xl"
            disabled={pending}
            onClick={() => {
              setMode("existing")
              setProductId(s.product_id)
            }}
          >
            <Check className="size-4" aria-hidden />
            Use
          </Button>
          <Button size="sm" variant="ghost" className="rounded-4xl" disabled={pending} onClick={() => reject(s.product_id)}>
            <X className="size-4" aria-hidden />
            Not this
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap gap-1 text-xs" role="radiogroup" aria-label="Product">
        {(["existing", "new"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            disabled={m === "existing" && products.length === 0}
            onClick={() => setMode(m)}
            className={
              mode === m
                ? "rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground"
                : "rounded-full border border-border px-3 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
            }
          >
            {m === "existing" ? "Existing product" : "New product"}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem] sm:items-end">
        {mode === "existing" ? (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-product`} className="text-xs">
              Product
            </Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger id={`${id}-product`} className="w-full">
                <SelectValue placeholder="Choose a product" />
              </SelectTrigger>
              <SelectContent>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.sku_code ? ` · ${p.sku_code}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-sku`} className="text-xs">
                Product SKU
              </Label>
              <Input
                id={`${id}-sku`}
                maxLength={120}
                placeholder="e.g. SG-T84D"
                value={newSku}
                onChange={(e) => setNewSku(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-name`} className="text-xs">
                Product name
              </Label>
              <Input id={`${id}-name`} maxLength={200} value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-cost`} className="text-xs">
            COGS / unit{singleCurrency ? ` (${singleCurrency})` : ""}
          </Label>
          <Input
            id={`${id}-cost`}
            inputMode="decimal"
            placeholder={singleCurrency ? "Optional" : "Per currency"}
            disabled={!singleCurrency}
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            className="font-mono tabular-nums"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" className="rounded-4xl" disabled={pending || !ready} onClick={save}>
          {mode === "existing" ? <Check className="size-4" aria-hidden /> : <Plus className="size-4" aria-hidden />}
          {pending ? "Saving…" : "Save & Match"}
        </Button>
        {!singleCurrency && (
          <p className="text-[11px] text-muted-foreground">
            This SKU sells in {currencies}: add its costs per currency in the product panel.
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger-strong">
          {error}
        </p>
      )}
    </div>
  )
}
