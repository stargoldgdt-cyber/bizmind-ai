"use client"

import { Check, ChevronsUpDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { switchBusinessAction } from "@/features/businesses/actions"
import type { BusinessWithRole } from "@/types/database"

/**
 * Switches which business the user is viewing.
 *
 * Each option submits a form rather than setting a cookie in the browser. The
 * server re-checks membership before honouring the change, because a
 * client-set value is a request, never an authority.
 *
 * With one business this renders as a plain label — a dropdown offering a
 * single choice is noise.
 */
export function BusinessSwitcher({
  businesses,
  activeId,
}: {
  businesses: BusinessWithRole[]
  activeId: string
}) {
  const active = businesses.find((b) => b.id === activeId) ?? businesses[0]

  if (businesses.length <= 1) {
    return (
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{active?.name}</p>
        <p className="text-xs text-muted-foreground">{active?.currency}</p>
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-auto w-full justify-between px-2.5 py-1.5 text-left"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{active?.name}</span>
            <span className="block text-xs text-muted-foreground">
              {active?.currency} · {active?.role}
            </span>
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Your businesses</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {businesses.map((business) => (
          <form key={business.id} action={switchBusinessAction}>
            <input type="hidden" name="businessId" value={business.id} />
            <DropdownMenuItem asChild>
              <button type="submit" className="w-full cursor-pointer">
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate">{business.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {business.currency} · {business.role}
                  </span>
                </span>
                {business.id === activeId && (
                  <Check className="size-4 shrink-0" aria-hidden />
                )}
              </button>
            </DropdownMenuItem>
          </form>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
