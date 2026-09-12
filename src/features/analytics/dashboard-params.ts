import type { AnalyticsScope } from "@/services/analytics"

import { param, type PageParams } from "./page-context"

/**
 * The dashboard's filters live in the URL.
 *
 * WHY THE URL AND NOT COMPONENT STATE
 * -----------------------------------
 * A filtered dashboard is a thing an owner sends to their accountant, keeps in
 * a tab, and comes back to tomorrow. In the URL it can be bookmarked, shared
 * and reloaded, the back button undoes a choice, and every server component
 * renders against the same filters without any of them being passed down.
 *
 * The channel is a filter, not a page: `?channel=<id>` narrows what is shown,
 * `?channel=none` shows orders with no channel recorded, and no parameter at
 * all means every channel. An unrecognised value falls back to every channel
 * rather than erroring — a mistyped URL should show the owner their business.
 */

/** `?channel=none`: orders the source never attributed to a channel. */
export const NO_CHANNEL = "none"

/** Parameters carried across a filter change. Anything else is dropped. */
const CARRIED = ["range", "from", "to", "channel", "sort"] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChannelChoice =
  | { kind: "all" }
  | { kind: "channel"; channelId: string }
  | { kind: "unattributed" }

/**
 * The channel filter, read from the URL.
 *
 * The id is only checked for SHAPE here. It is not trusted: it goes to the
 * analytics functions as a filter, and Row Level Security means another
 * business's channel id matches nothing rather than revealing anything.
 */
export function channelFromParams(params: PageParams): ChannelChoice {
  const value = param(params, "channel")

  if (!value) return { kind: "all" }
  if (value === NO_CHANNEL) return { kind: "unattributed" }
  if (UUID.test(value)) return { kind: "channel", channelId: value }

  return { kind: "all" }
}

/** The analytics scope for a channel choice. */
export function scopeFor(choice: ChannelChoice): AnalyticsScope {
  if (choice.kind === "channel") return { kind: "channel", channelId: choice.channelId }
  if (choice.kind === "unattributed") return { kind: "unattributed" }
  return { kind: "all" }
}

/** The value a link should set for a choice — `null` clears the parameter. */
export function channelParamFor(choice: ChannelChoice): string | null {
  if (choice.kind === "channel") return choice.channelId
  if (choice.kind === "unattributed") return NO_CHANNEL
  return null
}

/**
 * A link to the same page with some filters changed and the rest kept.
 *
 * `null` removes a parameter, which is how "All channels" is expressed: the
 * absence of a filter, not a magic value.
 */
export function filterHref(
  basePath: string,
  params: PageParams,
  overrides: Record<string, string | null> = {}
): string {
  const search = new URLSearchParams()

  for (const key of CARRIED) {
    const value = param(params, key)
    if (value) search.set(key, value)
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) search.delete(key)
    else search.set(key, value)
  }

  const query = search.toString()
  return query ? `${basePath}?${query}` : basePath
}
