"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useTransition } from "react"

import { cn } from "cn"
import { PNL_PERIOD_KEYS, PNL_PERIOD_LABEL, type PnlPeriodKey } from "@/services/ledger/pnl-period"

/**
 * This Month / Last Month / This Quarter / This Year / Custom Range.
 *
 * Sits alongside the existing account and month selectors (LedgerFilters):
 * the month dropdown still chooses the ANCHOR month; this picker decides how
 * much of the calendar around that anchor the P&L covers. Only the `period`
 * URL parameter changes here, so account and month stay exactly as chosen.
 * No period is money, so nothing here touches the money-guard.
 */
export function PnlPeriodPicker({ period }: { period: PnlPeriodKey }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const go = (key: PnlPeriodKey) =>
    startTransition(() => {
      const query = new URLSearchParams(searchParams.toString())
      query.set("period", key)
      router.push(`/ledger?${query.toString()}`)
    })

  return (
    <div
      role="radiogroup"
      aria-label="Period"
      aria-busy={pending}
      className="inline-flex flex-wrap rounded-full border border-border bg-card p-0.5"
    >
      {PNL_PERIOD_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={period === key}
          onClick={() => go(key)}
          className={cn(
            "rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
            period === key
              ? "bg-primary font-medium text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {PNL_PERIOD_LABEL[key]}
        </button>
      ))}
    </div>
  )
}
