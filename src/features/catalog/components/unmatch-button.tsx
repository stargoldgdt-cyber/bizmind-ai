"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Undo2, Unlink } from "lucide-react"

import { Button } from "@/components/ui/button"
import { decideSkuAction } from "@/features/catalog/actions"

/**
 * Takes a SKU off a product by recording "not this product" (REJECTED), never
 * by deleting the decision: an automatic match must not come back on the next
 * upload (migration 0045). The SKU returns to Needs attention.
 */
export function UnmatchButton({
  marketplaceCode,
  rawSku,
  productId,
  automatic,
}: {
  marketplaceCode: string
  rawSku: string
  productId: string
  automatic: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const Icon = automatic ? Undo2 : Unlink

  return (
    <div className="grid justify-items-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="rounded-4xl"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null)
            const result = await decideSkuAction({ marketplaceCode, rawSku, productId, decision: "REJECTED" })
            if (!result.ok) setError(result.error)
            else router.refresh()
          })
        }
      >
        <Icon className="size-4" aria-hidden />
        {pending ? "Working…" : automatic ? "Undo" : "Unmatch"}
      </Button>
      {error && (
        <span role="alert" className="text-[11px] text-danger-strong">
          {error}
        </span>
      )}
    </div>
  )
}
