"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { CalendarRange, Check } from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { ResolvedPeriod } from "@/services/analytics"

/**
 * Period selector.
 *
 * FOUR CONTROLS, NOT EIGHT.
 *
 * The previous version showed every period as a permanent button — Today,
 * Yesterday, 7, 30, 90, this month, last month, 12 months. Eight equally
 * weighted choices is not a filter, it is a decision the owner has to make
 * before they can read their own dashboard, every single time.
 *
 * Three cover almost every visit. Everything else lives behind Custom, which
 * is where a deliberate choice belongs.
 *
 * THE THREE QUICK RANGES ARE LINKS.
 * They work before JavaScript loads, can be bookmarked, and survive a refresh,
 * because the period lives in the URL rather than in component state.
 *
 * NO DATE ARITHMETIC HAPPENS HERE. This collects two dates and puts them in
 * the URL; `periodFromParams()` hands them to the analytics service, which
 * owns every rule about bounds and comparison windows.
 */

const QUICK: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
]

export function RangeSelector({
  active,
  basePath = "/dashboard",
  customLabel,
}: {
  active: ResolvedPeriod["key"]
  basePath?: string
  /** The resolved label of the current custom range, shown on the trigger. */
  customLabel?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")

  const isCustom = active === "custom"
  const invalid = from !== "" && to !== "" && from > to

  function apply() {
    if (!from || !to || invalid) return
    setOpen(false)
    router.push(`${basePath}?range=custom&from=${from}&to=${to}`)
  }

  return (
    <div
      className="flex items-center gap-1 rounded-4xl border border-border bg-card p-1"
      role="group"
      aria-label="Reporting period"
    >
      {QUICK.map((option) => {
        const selected = option.value === active
        return (
          <Link
            key={option.value}
            href={`${basePath}?range=${option.value}`}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "rounded-4xl px-3 py-1.5 text-xs font-medium transition-colors",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {option.label}
          </Link>
        )
      })}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-current={isCustom ? "true" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-4xl px-3 py-1.5 text-xs font-medium transition-colors",
              isCustom
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <CalendarRange className="size-3.5" aria-hidden />
            {isCustom && customLabel ? customLabel : "Custom"}
          </button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-72">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="range-from" className="text-xs font-medium">
                From
              </label>
              <Input
                id="range-from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="range-to" className="text-xs font-medium">
                To
              </label>
              <Input
                id="range-to"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>

            {invalid && (
              <p role="alert" className="text-xs text-danger-strong">
                The start date is after the end date.
              </p>
            )}

            <Button
              onClick={apply}
              disabled={!from || !to || invalid}
              className="w-full rounded-4xl"
              size="sm"
            >
              <Check className="size-4" aria-hidden />
              Apply
            </Button>

            <p className="text-xs text-muted-foreground">
              Compared against the equally long range immediately before it.
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
