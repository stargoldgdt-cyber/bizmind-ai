"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Check, Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createProductFromSkuAction, decideSkuAction } from "@/features/catalog/actions"
import { SUGGESTION_REASON_LABEL, type SuggestionReason } from "@/services/catalog/sku"

/**
 * Matching one marketplace SKU to a product. Suggestions are only offered;
 * nothing is matched until a person confirms (A10). Rejecting a suggestion
 * stops it being offered again for this SKU.
 */
export function SkuMatchControls({
  marketplaceCode,
  rawSku,
  suggestedName,
  suggestions,
  products,
}: {
  marketplaceCode: string
  rawSku: string
  suggestedName: string
  suggestions: { product_id: string; name: string; reason: SuggestionReason }[]
  products: { id: string; name: string; sku_code: string | null }[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState("")
  const [newName, setNewName] = useState(suggestedName)
  const [creating, setCreating] = useState(false)

  const run = (task: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    startTransition(async () => {
      setError(null)
      const result = await task()
      if (!result.ok) setError(result.error)
      else router.refresh()
    })

  const decide = (productId: string, decision: "CONFIRMED" | "REJECTED") =>
    run(() => decideSkuAction({ marketplaceCode, rawSku, productId, decision }))

  return (
    <div className="grid gap-3" aria-busy={pending}>
      {suggestions.map((s) => (
        <div
          key={`${s.product_id}-${s.reason}`}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-info/40 bg-info-subtle px-3 py-2"
        >
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{s.name}</span>
            <span className="block text-[11px] text-muted-foreground">
              Suggested: {SUGGESTION_REASON_LABEL[s.reason]}
            </span>
          </p>
          <Button size="sm" className="rounded-4xl" disabled={pending} onClick={() => decide(s.product_id, "CONFIRMED")}>
            <Check className="size-4" aria-hidden />
            Confirm
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-4xl"
            disabled={pending}
            onClick={() => decide(s.product_id, "REJECTED")}
          >
            <X className="size-4" aria-hidden />
            Not this
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={chosen} onValueChange={setChosen}>
          <SelectTrigger className="w-64" aria-label={`Product for ${rawSku}`}>
            <SelectValue placeholder={products.length ? "Choose a product" : "No products yet"} />
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
        <Button
          size="sm"
          variant="outline"
          className="rounded-4xl"
          disabled={pending || chosen === ""}
          onClick={() => decide(chosen, "CONFIRMED")}
        >
          <Check className="size-4" aria-hidden />
          Match
        </Button>
        {!creating && (
          <Button size="sm" variant="ghost" className="rounded-4xl" disabled={pending} onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            New product from this SKU
          </Button>
        )}
      </div>

      {creating && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-72"
            aria-label="New product name"
            maxLength={200}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button
            size="sm"
            className="rounded-4xl"
            disabled={pending || newName.trim() === ""}
            onClick={() => run(() => createProductFromSkuAction({ marketplaceCode, rawSku, name: newName }))}
          >
            <Plus className="size-4" aria-hidden />
            Create and match
          </Button>
          <Button size="sm" variant="ghost" className="rounded-4xl" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-danger-strong">
          {error}
        </p>
      )}
    </div>
  )
}
