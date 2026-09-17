"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Plus, Save } from "lucide-react"

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
import { createProductAction, updateProductAction } from "@/features/catalog/actions"

type Existing = {
  id: string
  name: string
  sku_code: string | null
  category: string | null
  brand: string | null
  status: "ACTIVE" | "ARCHIVED"
}

/**
 * Add a product, or edit one. The SKU code is the business's own code; it is
 * used only to suggest matches with marketplace SKUs, never to match them.
 */
export function ProductForm({ product }: { product?: Existing }) {
  const router = useRouter()
  const [name, setName] = useState(product?.name ?? "")
  const [skuCode, setSkuCode] = useState(product?.sku_code ?? "")
  const [category, setCategory] = useState(product?.category ?? "")
  const [brand, setBrand] = useState(product?.brand ?? "")
  const [status, setStatus] = useState<"ACTIVE" | "ARCHIVED">(product?.status ?? "ACTIVE")
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  return (
    <form
      className="grid gap-4 rounded-xl border border-border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault()
        startTransition(async () => {
          setError(null)
          setSaved(false)
          const fields = { name, skuCode, category, brand }
          const result = product
            ? await updateProductAction({ ...fields, productId: product.id, status })
            : await createProductAction(fields)
          if (!result.ok) {
            setError(result.error)
            return
          }
          setSaved(true)
          if (!product) {
            setName("")
            setSkuCode("")
            setCategory("")
            setBrand("")
          }
          router.refresh()
        })
      }}
    >
      <div>
        <h2 className="text-sm font-semibold">{product ? "Product details" : "Add a product"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {product
            ? "Changes apply everywhere the product appears, for every period."
            : "One entry per physical product. Marketplace SKUs are matched to it afterwards."}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="product-name">Name</Label>
          <Input id="product-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="product-sku">Your SKU code (optional)</Label>
          <Input id="product-sku" value={skuCode} maxLength={120} onChange={(e) => setSkuCode(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="product-category">Category (optional)</Label>
          <Input id="product-category" value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="product-brand">Brand (optional)</Label>
          <Input id="product-brand" value={brand} maxLength={80} onChange={(e) => setBrand(e.target.value)} />
        </div>
        {product && (
          <div className="grid gap-1.5">
            <Label htmlFor="product-status">Status</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as "ACTIVE" | "ARCHIVED")}>
              <SelectTrigger id="product-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="ARCHIVED">Archived (kept for past figures)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-strong">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-success-strong">
          {product ? "Saved." : "Product added."}
        </p>
      )}

      <div>
        <Button type="submit" className="rounded-4xl" disabled={pending || name.trim() === ""}>
          {product ? <Save className="size-4" aria-hidden /> : <Plus className="size-4" aria-hidden />}
          {pending ? "Saving…" : product ? "Save" : "Add product"}
        </Button>
      </div>
    </form>
  )
}
