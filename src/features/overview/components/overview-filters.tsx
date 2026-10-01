"use client"

import { useRouter } from "next/navigation"
import { useTransition } from "react"

import { cn } from "cn"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PERIOD_KEYS, PERIOD_LABEL, type PeriodKey } from "@/services/overview/period"

/**
 * What the executive dashboard shows: the whole business (every account in a
 * currency) or one account, a period, and the month it ends on. All three
 * live in the URL, and the server recomputes every figure for the choice --
 * nothing is filtered in the browser.
 */
export function OverviewFilters({
  scopes,
  scope,
  period,
  months,
  endMonth,
}: {
  scopes: { id: string; label: string; detail: string }[]
  scope: string
  period: PeriodKey
  months: { key: string; label: string }[]
  endMonth: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const go = (next: { scope?: string; period?: PeriodKey; month?: string | null }) =>
    startTransition(() => {
      const query = new URLSearchParams({ account: next.scope ?? scope, period: next.period ?? period })
      const month = next.month === undefined ? endMonth : next.month
      if (month) query.set("month", month)
      router.push(`/overview?${query.toString()}`)
    })

  return (
    <div className="flex flex-wrap items-end gap-4" aria-busy={pending}>
      <div className="grid gap-1.5">
        <Label htmlFor="overview-scope">Showing</Label>
        <Select value={scope} onValueChange={(value) => go({ scope: value, month: null })}>
          <SelectTrigger id="overview-scope" className="w-72 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {scopes.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label} · {s.detail}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <span className="text-sm font-medium" id="overview-period-label">
          Period
        </span>
        <div
          role="radiogroup"
          aria-labelledby="overview-period-label"
          className="inline-flex flex-wrap rounded-full border border-border bg-card p-0.5"
        >
          {PERIOD_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={period === key}
              onClick={() => go({ period: key })}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm transition-colors",
                period === key ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {PERIOD_LABEL[key]}
            </button>
          ))}
        </div>
      </div>

      {months.length > 0 && endMonth && (
        <div className="grid gap-1.5">
          <Label htmlFor="overview-month">{period === "1m" ? "Month" : "Ending"}</Label>
          <Select value={endMonth} onValueChange={(value) => go({ month: value })}>
            <SelectTrigger id="overview-month" className="w-44">
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
      )}

      {pending && <p className="pb-2 text-xs text-muted-foreground">Recalculating…</p>}
    </div>
  )
}
