"use client"

import Link from "next/link"
import { useState } from "react"
import { Check, ChevronDown, Store } from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * The channel filter.
 *
 * THE CHANNELS ARE THE BUSINESS'S OWN.
 * Nothing here is hard-coded: the list is whatever channels this business
 * actually has, passed in by the page from the canonical channel data. A
 * business with one channel still sees "All channels" plus that one, because
 * the control's presence is what tells an owner the dashboard can be filtered.
 *
 * EVERY OPTION IS A LINK. They work before JavaScript loads, can be
 * bookmarked, and the back button undoes a choice — the filter lives in the
 * URL, not in component state.
 *
 * "Orders with no channel" is offered only when there are some. It is a real
 * slice of the business, not an error state, and an owner needs to be able to
 * look at it; offering it when it is empty would just be noise.
 */

export type ChannelOption = {
  id: string
  name: string
  /** Shown beside the name so a busy list stays scannable. */
  detail?: string
}

export function ChannelFilter({
  options,
  activeId,
  unattributedSelected,
  unattributedAvailable,
  hrefFor,
}: {
  options: ChannelOption[]
  /** The selected channel, or null for every channel. */
  activeId: string | null
  unattributedSelected: boolean
  unattributedAvailable: boolean
  /** Builds the link for a choice, keeping the other filters. */
  hrefFor: (channel: string | null) => string
}) {
  const [open, setOpen] = useState(false)

  const active = options.find((option) => option.id === activeId)
  const label = unattributedSelected
    ? "No channel"
    : (active?.name ?? "All channels")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="rounded-4xl"
          aria-label={`Channel: ${label}. Change the channel`}
        >
          <Store className="size-4" aria-hidden />
          <span className="max-w-40 truncate">{label}</span>
          <ChevronDown className="size-4 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-1.5">
        <p className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
          Show figures for
        </p>

        <ul className="max-h-72 overflow-y-auto">
          <ChoiceRow
            href={hrefFor(null)}
            label="All channels"
            selected={activeId === null && !unattributedSelected}
            onNavigate={() => setOpen(false)}
          />

          {options.map((option) => (
            <ChoiceRow
              key={option.id}
              href={hrefFor(option.id)}
              label={option.name}
              detail={option.detail}
              selected={option.id === activeId}
              onNavigate={() => setOpen(false)}
            />
          ))}

          {unattributedAvailable && (
            <ChoiceRow
              href={hrefFor("none")}
              label="No channel"
              detail="Orders with none recorded"
              selected={unattributedSelected}
              onNavigate={() => setOpen(false)}
            />
          )}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function ChoiceRow({
  href,
  label,
  detail,
  selected,
  onNavigate,
}: {
  href: string
  label: string
  detail?: string
  selected: boolean
  onNavigate: () => void
}) {
  return (
    <li>
      <Link
        href={href}
        onClick={onNavigate}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors",
          selected ? "bg-accent font-medium text-accent-foreground" : "hover:bg-accent/60"
        )}
      >
        <span className="min-w-0">
          <span className="block truncate">{label}</span>
          {detail && (
            <span className="block truncate text-xs text-muted-foreground">{detail}</span>
          )}
        </span>
        {selected && <Check className="size-4 shrink-0" aria-hidden />}
      </Link>
    </li>
  )
}
