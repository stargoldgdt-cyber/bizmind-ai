"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Undo2, Unlink } from "lucide-react"

import { Button } from "@/components/ui/button"
import { removeSkuMatchAction, retireProductCostAction } from "@/features/catalog/actions"

/**
 * One-click row actions: withdraw a cost, or remove a SKU match. Both are
 * audited in the database and change figures for every period they touch.
 */
export function RowActionButton({ kind, id }: { kind: "retire-cost" | "remove-match"; id: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const label = kind === "retire-cost" ? "Withdraw" : "Remove"
  const Icon = kind === "retire-cost" ? Undo2 : Unlink

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
            const result =
              kind === "retire-cost"
                ? await retireProductCostAction({ costId: id })
                : await removeSkuMatchAction(id)
            if (!result.ok) setError(result.error)
            else router.refresh()
          })
        }
      >
        <Icon className="size-4" aria-hidden />
        {pending ? "Working…" : label}
      </Button>
      {error && (
        <span role="alert" className="text-[11px] text-danger-strong">
          {error}
        </span>
      )}
    </div>
  )
}
