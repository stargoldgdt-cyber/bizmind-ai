"use client"

import { useSyncExternalStore } from "react"

/**
 * "Good morning/afternoon/evening/night, {name}" -- by the VIEWER's own
 * clock, not the server's.
 *
 * This page is a Server Component; a server only knows its own clock, which
 * for a GCC seller is very often the wrong half of the day (a server in a
 * different region at 09:00 UTC is 13:00 in Dubai -- "morning" would be
 * wrong for most of the day). The only clock that is actually correct for
 * "good morning" is the one the person reading it is sitting next to, so
 * this is computed in the browser, from `Date()`.
 *
 * `useSyncExternalStore` (not `useEffect` + `useState`) is the fit here: it
 * has a dedicated server snapshot (null -- the server-sent HTML makes no
 * claim about the time of day at all, rather than a wrong one that would
 * flash and correct itself) and a subscription that re-checks the clock once
 * a minute, so the greeting turns over live if the dashboard is left open
 * across the boundary. Never a page reload, never a guess at a time zone to
 * store.
 */

type Period = "morning" | "afternoon" | "evening" | "night"

function periodNow(): Period {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return "morning"
  if (hour >= 12 && hour < 17) return "afternoon"
  if (hour >= 17 && hour < 21) return "evening"
  return "night"
}

function subscribe(onChange: () => void) {
  const id = setInterval(onChange, 60_000)
  return () => clearInterval(id)
}

function getServerSnapshot(): Period | null {
  return null
}

export function Greeting({ name }: { name: string | null }) {
  const period = useSyncExternalStore(subscribe, periodNow, getServerSnapshot)
  if (period === null) return null
  return (
    <span className="inline-flex items-center gap-1.5">
      Good {period}{name ? `, ${name}` : ""}
      <span aria-hidden>👋</span>
    </span>
  )
}
