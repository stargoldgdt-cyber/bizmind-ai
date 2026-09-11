import { cn } from "cn"

import { connect } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * Integrations.
 *
 * THE STATUS BADGE IS THE MOST IMPORTANT ELEMENT ON THIS PAGE.
 *
 * Every SaaS landing page shows a wall of logos implying they all work today.
 * Two of these six do. Presenting the rest as available would be the kind of
 * claim a buyer discovers on day one, and it would poison everything else the
 * page says — including the parts that are scrupulously true.
 *
 * So the status is rendered at the same weight as the name, never smaller,
 * and the footnote defines the words rather than leaving "coming soon" to mean
 * whatever the reader hopes.
 *
 * When Shopify ships, one string changes in content.ts.
 */

const STATUS_STYLES = {
  live: "border-success/35 bg-success-subtle text-success-strong",
  beta: "border-warning/35 bg-warning-subtle text-warning-strong",
  planned: "border-surface-1-border bg-surface-2 text-surface-1-muted",
} as const

export function Connect() {
  return (
    <Band level="1" id="connect">
      <SectionHeader
        level="1"
        eyebrow={connect.eyebrow}
        headline={connect.headline}
        support={connect.support}
        align="center"
      />

      <ul className="mx-auto mt-12 grid max-w-4xl gap-px overflow-hidden rounded-2xl border border-surface-1-border bg-surface-1-border sm:grid-cols-2 lg:grid-cols-3">
        {connect.sources.map((source) => {
          const status = source.status as keyof typeof STATUS_STYLES

          return (
            <li
              key={source.name}
              className="flex items-center justify-between gap-4 bg-surface-1 px-5 py-5"
            >
              <span
                className={cn(
                  "font-heading font-semibold tracking-tight",
                  status === "planned" && "text-surface-1-muted"
                )}
              >
                {source.name}
              </span>

              <span
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium",
                  STATUS_STYLES[status]
                )}
              >
                {connect.statusLabels[status]}
              </span>
            </li>
          )
        })}
      </ul>

      <p className="mx-auto mt-6 max-w-prose-comfortable text-center text-sm text-surface-1-muted">
        {connect.footnote}
      </p>
    </Band>
  )
}
