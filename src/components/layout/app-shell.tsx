import { LogOut } from "lucide-react"

import { Logo } from "@/components/brand/logo"
import { MobileNav } from "@/components/layout/mobile-nav"
import { SidebarNav } from "@/components/layout/sidebar-nav"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { signOutAction } from "@/features/auth/actions"
import { BusinessSwitcher } from "@/features/businesses/components/business-switcher"
import type { BusinessWithRole } from "@/types/database"

/**
 * The frame every signed-in page sits in.
 *
 * Product register, not marketing: one calm surface, compact spacing, and
 * violet reserved for actions and active state. The data is meant to be the
 * loudest thing on screen, so the chrome deliberately is not.
 */
export function AppShell({
  businesses,
  activeBusinessId,
  userEmail,
  userName,
  children,
}: {
  businesses: BusinessWithRole[]
  activeBusinessId: string
  userEmail: string
  userName: string | null
  children: React.ReactNode
}) {
  const initials = (userName ?? userEmail)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")

  return (
    <div className="min-h-dvh bg-surface-2 text-surface-2-foreground">
      {/* Desktop rail. A light sidebar keeps attention on the data; a dark
          rail would compete with it. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="flex h-16 items-center border-b border-sidebar-border px-5">
          <Logo />
        </div>

        <div className="border-b border-sidebar-border p-3">
          <BusinessSwitcher businesses={businesses} activeId={activeBusinessId} />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-4">
          <SidebarNav />
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-surface-1/85 px-4 backdrop-blur-md sm:px-6">
          <MobileNav />

          <div className="lg:hidden">
            <Logo />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Account menu">
                  <Avatar className="size-8">
                    <AvatarFallback className="text-xs">{initials || "?"}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="font-normal">
                  <span className="block text-sm font-medium">{userName ?? "Signed in"}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {userEmail}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <form action={signOutAction} className="w-full">
                    <button type="submit" className="flex w-full cursor-pointer items-center gap-2">
                      <LogOut className="size-4" aria-hidden />
                      Sign out
                    </button>
                  </form>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Mobile business switcher: no room for it in the top bar. */}
        <div className="border-b border-border bg-surface-1 px-4 py-3 sm:px-6 lg:hidden">
          <BusinessSwitcher businesses={businesses} activeId={activeBusinessId} />
        </div>

        <main className="px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  )
}
