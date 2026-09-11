"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Search, X } from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { OrderStatus } from "@/types/database"

/**
 * Filters for the sales table.
 *
 * THEY NAVIGATE RATHER THAN HOLD STATE.
 *
 * Each control writes to the URL and the server re-queries. That keeps the
 * filtering in the database where it belongs, and it means a filtered view can
 * be bookmarked, shared with an accountant, and survives a refresh — none of
 * which is true of client-side state.
 *
 * The search box is the one exception: it holds a draft locally until the
 * owner submits, because navigating on every keystroke would fire a query per
 * character.
 */
export function OrderFilters({
  channels,
  statuses,
  range,
  activeStatus,
  activeChannel,
  activeSearch,
}: {
  channels: { id: string; name: string }[]
  statuses: OrderStatus[]
  range: string
  activeStatus?: string
  activeChannel?: string
  activeSearch?: string
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(activeSearch ?? "")

  const build = (changes: Record<string, string | undefined>): string => {
    const params = new URLSearchParams()
    params.set("range", range)

    const next = {
      status: activeStatus,
      channel: activeChannel,
      q: activeSearch,
      ...changes,
    }

    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value)
    }

    return `/sales?${params.toString()}`
  }

  const hasFilters = Boolean(activeStatus || activeChannel || activeSearch)

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          router.push(build({ q: draft.trim() || undefined }))
        }}
        className="flex gap-2"
        role="search"
      >
        <div className="relative flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search order number"
            aria-label="Search by order number"
            className="pl-9"
            maxLength={60}
          />
        </div>
        <Button type="submit" variant="outline" className="rounded-4xl">
          Search
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <FilterGroup label="Status">
          <Chip href={build({ status: undefined })} active={!activeStatus}>
            All
          </Chip>
          {statuses.map((status) => (
            <Chip
              key={status}
              href={build({ status })}
              active={activeStatus === status}
            >
              {status.charAt(0) + status.slice(1).toLowerCase()}
            </Chip>
          ))}
        </FilterGroup>

        {channels.length > 0 && (
          <FilterGroup label="Channel">
            <Chip href={build({ channel: undefined })} active={!activeChannel}>
              All
            </Chip>
            {channels.map((channel) => (
              <Chip
                key={channel.id}
                href={build({ channel: channel.id })}
                active={activeChannel === channel.id}
              >
                {channel.name}
              </Chip>
            ))}
          </FilterGroup>
        )}

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-4xl"
            onClick={() => {
              setDraft("")
              router.push(`/sales?range=${range}`)
            }}
          >
            <X className="size-3.5" aria-hidden />
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}

function FilterGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Chip({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  const router = useRouter()

  return (
    <button
      type="button"
      onClick={() => router.push(href)}
      aria-pressed={active}
      className={cn(
        "rounded-4xl border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}
