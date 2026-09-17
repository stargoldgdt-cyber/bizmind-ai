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

/**
 * Account and month. Both live in the URL, and the server recomputes every
 * figure for the choice -- nothing is filtered in the browser.
 */
export function LedgerFilters({
  accounts,
  months,
  accountId,
  monthKey,
}: {
  accounts: { id: string; label: string; detail: string }[]
  months: { key: string; label: string }[]
  accountId: string
  monthKey: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const go = (account: string, month: string | null) =>
    startTransition(() => {
      const query = new URLSearchParams({ account })
      if (month) query.set("month", month)
      router.push(`/ledger?${query.toString()}`)
    })

  return (
    <div className="flex flex-wrap items-end gap-4" aria-busy={pending}>
      <div className="grid gap-1.5">
        <Label htmlFor="ledger-account">Marketplace account</Label>
        <Select value={accountId} onValueChange={(value) => go(value, null)}>
          <SelectTrigger id="ledger-account" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.label} · {account.detail}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {months.length > 0 && monthKey && (
        <div className="grid gap-1.5">
          <Label htmlFor="ledger-month">Month</Label>
          <Select value={monthKey} onValueChange={(value) => go(accountId, value)}>
            <SelectTrigger id="ledger-month" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((month) => (
                <SelectItem key={month.key} value={month.key}>
                  {month.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {pending && <p className="pb-2 text-xs text-muted-foreground">Recalculating…</p>}
    </div>
  )
}
