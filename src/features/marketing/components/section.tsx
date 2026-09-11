import type { ReactNode } from "react"

import { cn } from "cn"

/**
 * The marketing page's structural primitives.
 *
 * A landing page's premium quality comes almost entirely from rhythm — the
 * same margins, the same vertical intervals, the same distance between an
 * eyebrow and its headline, every time. Left to per-section judgement that
 * consistency erodes within an afternoon, so it is a component instead.
 *
 * Each band is a full-bleed colour field that carries its own foreground,
 * muted and border tokens (DESIGN.md §3). Nothing inside a band needs to know
 * whether it is on white or near-black, which is why there is not a single
 * `text-white` on this page.
 */

type Level = "1" | "2" | "3" | "brand"

const BANDS: Record<Level, string> = {
  "1": "bg-surface-1 text-surface-1-foreground",
  "2": "bg-surface-2 text-surface-2-foreground",
  "3": "bg-surface-3 text-surface-3-foreground",
  brand: "bg-surface-brand text-surface-brand-foreground",
}

const MUTED: Record<Level, string> = {
  "1": "text-surface-1-muted",
  "2": "text-surface-2-muted",
  "3": "text-surface-3-muted",
  brand: "text-surface-brand-muted",
}

const BORDER: Record<Level, string> = {
  "1": "border-surface-1-border",
  "2": "border-surface-2-border",
  "3": "border-surface-3-border",
  brand: "border-surface-brand-border",
}

/** The muted text colour for a band. Exported so sections stay token-only. */
export function mutedOn(level: Level): string {
  return MUTED[level]
}

/** The border colour for a band. */
export function borderOn(level: Level): string {
  return BORDER[level]
}

export function Band({
  level,
  id,
  className,
  children,
}: {
  level: Level
  id?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section
      id={id}
      className={cn("py-section-md", BANDS[level], className)}
      // Anchored sections need clearance for the sticky header, or a jump
      // link lands with the heading hidden underneath it.
      style={id ? { scrollMarginTop: "4rem" } : undefined}
    >
      <div className="mx-auto max-w-marketing px-5 sm:px-8">{children}</div>
    </section>
  )
}

/**
 * Eyebrow, headline, and at most one supporting sentence.
 *
 * The support line is capped at a comfortable measure rather than the band
 * width. A sentence running the full 80rem is technically readable and
 * practically skipped.
 */
export function SectionHeader({
  level,
  eyebrow,
  headline,
  support,
  align = "left",
  className,
}: {
  level: Level
  eyebrow: string
  headline: ReactNode
  support?: string
  align?: "left" | "center"
  className?: string
}) {
  return (
    <header
      className={cn(
        align === "center" && "mx-auto text-center",
        align === "center" ? "max-w-2xl" : "max-w-3xl",
        className
      )}
    >
      <p
        className={cn(
          "font-mono text-xs font-medium tracking-widest uppercase",
          level === "1" || level === "2" ? "text-primary" : "text-brand-300"
        )}
      >
        {eyebrow}
      </p>

      <h2 className="mt-3 font-heading text-3xl font-bold tracking-tighter text-balance sm:text-4xl">
        {headline}
      </h2>

      {support && (
        <p
          className={cn(
            "mt-4 text-base text-pretty sm:text-lg",
            align === "center" ? "mx-auto" : "",
            "max-w-prose-comfortable",
            MUTED[level]
          )}
        >
          {support}
        </p>
      )}
    </header>
  )
}
