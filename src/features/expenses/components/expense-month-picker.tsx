"use client"

import { useRouter } from "next/navigation"
import { useTransition } from "react"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/** The month lives in the URL; the server recomputes every figure for it. */
export function ExpenseMonthPicker({
  months,
  monthKey,
  basePath = "/ledger/expenses",
}: {
  months: { key: string; label: string }[]
  monthKey: string
  /** The screen the choice reloads. */
  basePath?: "/ledger/expenses" | "/ledger/payouts" | "/ledger/reports" | "/ledger/ask"
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <div className="flex flex-wrap items-end gap-4" aria-busy={pending}>
      <div className="grid gap-1.5">
        <Label htmlFor="expense-month">Month</Label>
        <Select
          value={monthKey}
          onValueChange={(value) => startTransition(() => router.push(`${basePath}?month=${value}`))}
        >
          <SelectTrigger id="expense-month" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m.key} value={m.key}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {pending && <p className="pb-2 text-xs text-muted-foreground">Recalculating…</p>}
    </div>
  )
}
