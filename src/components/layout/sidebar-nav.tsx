"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "cn"
import { NAVIGATION } from "@/config/navigation"

/**
 * The navigation list, shared by the desktop rail and the mobile sheet.
 *
 * Items whose phase has not shipped render as disabled text rather than links,
 * so the product's shape is visible without any click leading nowhere.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-6" aria-label="Main">
      {NAVIGATION.map((section) => (
        <div key={section.heading}>
          <p className="px-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            {section.heading}
          </p>

          <ul className="mt-2 space-y-0.5">
            {section.items.map((item) => {
              const Icon = item.icon
              const active = pathname === item.href

              if (item.phase) {
                return (
                  <li key={item.href}>
                    <span
                      className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground/55"
                      title={`Arrives in phase ${item.phase}`}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      <span className="flex-1">{item.label}</span>
                      <span className="text-[10px] font-medium tracking-wide tabular-nums">
                        P{item.phase}
                      </span>
                    </span>
                  </li>
                )
              }

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
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
