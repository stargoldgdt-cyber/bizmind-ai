"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { retireClassificationAction } from "@/features/ledger/actions"

/** Undo a business's own classification. The code becomes Unknown again. */
export function RetireClassificationButton({ ruleId }: { ruleId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

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
            const result = await retireClassificationAction(ruleId)
            if (!result.ok) setError(result.error)
            else router.refresh()
          })
        }
      >
        <Undo2 className="size-4" aria-hidden />
        {pending ? "Undoing…" : "Undo"}
      </Button>
      {error && (
        <span role="alert" className="text-[11px] text-danger-strong">
          {error}
        </span>
      )}
    </div>
  )
}
