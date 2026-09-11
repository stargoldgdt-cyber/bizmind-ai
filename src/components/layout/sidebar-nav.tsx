"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "cn"
import { isNavItemActive, visibleNavigation } from "@/config/navigation"

/**
 * The navigation list, shared by the desktop rail and the mobile sheet.
 *
 * Every row here is a working page. Unbuilt features are not rendered at all —
 * see the note in `src/config/navigation.ts` for why a greyed-out row is worse
 * than an absent one.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const sections = visibleNavigation()

  return (
    <nav className="flex flex-col gap-6" aria-label="Main">
      {sections.map((section) => (
        <div key={section.heading}>
          <p className="px-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            {section.heading}
          </p>

          <ul className="mt-2 space-y-0.5">
            {section.items.map((item) => {
              const Icon = item.icon
              const active = isNavItemActive(item, pathname)

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      // A generous target: this is the primary control on a
                      // phone, where it lives inside a sheet.
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-foreground hover:bg-muted"
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
