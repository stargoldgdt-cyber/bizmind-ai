"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Plus } from "lucide-react"

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
import { addProductCostAction } from "@/features/catalog/actions"

/**
 * Add a dated unit cost (A8). A cost applies to sales from its date until a
 * later-dated cost in the same currency. A past date is allowed on purpose:
 * it is the audited backfill that makes earlier months final (B7).
 */
export function ProductCostForm({ productId, currencies }: { productId: string; currencies: string[] }) {
  const router = useRouter()
  const [currency, setCurrency] = useState(currencies[0] ?? "")
  const [unitCost, setUnitCost] = useState("")
  const [effectiveFrom, setEffectiveFrom] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  if (currencies.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        Add a marketplace account first: costs are entered in the currencies you sell in.
      </p>
    )
  }

  return (
    <form
      className="grid gap-4 rounded-xl border border-border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault()
        startTransition(async () => {
          setError(null)
          setSaved(false)
          const result = await addProductCostAction({ productId, currency, unitCost, effectiveFrom, note })
          if (!result.ok) {
            setError(result.error)
            return
          }
          setSaved(true)
          setUnitCost("")
          setNote("")
          router.refresh()
        })
      }}
    >
      <div>
        <h2 className="text-sm font-semibold">Add a cost</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What one unit cost you, from a date. Sales on or after that date use it until a newer
          cost starts. A past date updates earlier months too, and is recorded in the audit log.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="cost-currency">Currency</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="cost-currency" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {currencies.map((code) => (
                <SelectItem key={code} value={code}>
                  {code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cost-amount">Cost per unit</Label>
          <Input
            id="cost-amount"
            inputMode="decimal"
            placeholder="42.50"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cost-from">Applies from</Label>
          <Input id="cost-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5 sm:col-span-3">
          <Label htmlFor="cost-note">Note (optional)</Label>
          <Input
            id="cost-note"
            maxLength={300}
            placeholder="Supplier invoice, landed cost…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-strong">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-success-strong">
          Cost added.
        </p>
      )}

      <div>
        <Button type="submit" className="rounded-4xl" disabled={pending || unitCost.trim() === "" || effectiveFrom === ""}>
          <Plus className="size-4" aria-hidden />
          {pending ? "Adding…" : "Add cost"}
        </Button>
      </div>
    </form>
  )
}
