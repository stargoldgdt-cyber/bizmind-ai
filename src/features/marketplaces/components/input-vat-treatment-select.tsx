"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { setInputVatTreatmentAction } from "@/features/marketplaces/actions"
import type { InputVatTreatment } from "@/services/classification/model"

/**
 * The account's VAT setting for marketplace fees (decision B1), owner only.
 *
 * Recoverable: the VAT stays on the tax ledger and out of profit.
 * Non-recoverable: it counts as an expense.
 * Unknown: contribution is shown as incomplete until this is set.
 *
 * The database checks the owner role again and records the change in the
 * audit log; nothing in the ledger changes when this does.
 */
export function InputVatTreatmentSelect({
  accountId,
  value,
}: {
  accountId: string
  value: InputVatTreatment
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="grid gap-1">
      <Select
        value={value}
        disabled={pending}
        onValueChange={(next) =>
          startTransition(async () => {
            setError(null)
            const result = await setInputVatTreatmentAction({ accountId, treatment: next })
            if (!result.ok) setError(result.error)
            else router.refresh()
          })
        }
      >
        <SelectTrigger className="h-8 w-44" aria-label="VAT on marketplace fees">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="UNKNOWN">Unknown</SelectItem>
          <SelectItem value="RECOVERABLE">Recoverable</SelectItem>
          <SelectItem value="NON_RECOVERABLE">Non-recoverable</SelectItem>
        </SelectContent>
      </Select>
      {value === "UNKNOWN" && (
        <span className="text-[11px] text-warning-strong">Contribution stays incomplete</span>
      )}
      {error && (
        <span role="alert" className="text-[11px] text-danger-strong">
          {error}
        </span>
      )}
    </div>
  )
}
