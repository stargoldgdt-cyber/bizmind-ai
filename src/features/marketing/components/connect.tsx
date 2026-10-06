import Image from "next/image"
import { FileSpreadsheet } from "lucide-react"

import { cn } from "cn"

import { connect } from "../content"
import { SectionHeader } from "./section"

/**
 * Marketplaces and sources, rebuilt to the owner's reference (2026-09-30):
 * a plain 3-across grid, no hub, no connectors -- a deliberate simplification
 * of the earlier hub-and-spoke version, matched to the reference exactly.
 * Each tile is the owner's own supplied logo image (public/logos/tiles/) --
 * not drawn.
 *
 * OWNER OVERRIDE, 2026-09-30: ALL SIX SOURCES RENDER IDENTICALLY
 * -----------------------------------------------------------------
 * Carrefour and bank statements render exactly like the live sources here --
 * no badge, no dashed border. That trade-off was flagged explicitly (see
 * git history / prior conversation): rendering them identically to Amazon
 * and noon means the homepage shows two unbuilt integrations as available
 * today, and the owner chose that anyway. `connect.sources[].status` still
 * records the truth in the data model -- scripts/verify-website.mts still
 * checks Carrefour and bank statements are labelled "planned" there -- only
 * this component's rendering doesn't surface it. That status field is
 * exactly what a future pass would key a visual distinction back off.
 */

/** A soft, brand-tinted glow in each card's corner, matching the reference. Marketing-only decoration, not a status signal. */
const WASH: Record<string, string> = {
  amazon: "bg-primary/20",
  noon: "bg-[#fde047]/50",
  carrefour: "bg-sky-300/40",
  sheets: "bg-success/20",
  excel: "bg-success/20",
  bank: "bg-primary/20",
}

function SourceCard({ source }: { source: (typeof connect.sources)[number] }) {
  return (
    <div className="relative flex min-w-0 items-center gap-3.5 overflow-hidden rounded-2xl border border-surface-1-border bg-surface-1 p-5">
      <div
        className={cn("pointer-events-none absolute -right-8 -bottom-10 size-28 rounded-full blur-2xl", WASH[source.key])}
        aria-hidden
      />
      <Image
        src={source.logo}
        alt={source.name}
        width={48}
        height={48}
        className="relative size-12 shrink-0 rounded-xl object-cover"
        unoptimized
      />
      <div className="relative min-w-0 flex-1">
        <p className="truncate font-heading text-base font-bold tracking-tight">{source.name}</p>
        <p className="mt-0.5 text-sm text-pretty text-surface-1-muted">{source.detail}</p>
      </div>
    </div>
  )
}

export function Connect() {
  const byKey = (key: string) => connect.sources.find((s) => s.key === key)!
  const ordered = ["amazon", "noon", "carrefour", "sheets", "excel", "bank"].map(byKey)

  return (
    <section
      id="connect"
      className="relative overflow-hidden bg-surface-2 py-section-md text-surface-2-foreground"
      style={{ scrollMarginTop: "4rem" }}
    >
      {/* Soft blob field + dot grid, matching the other rebuilt sections. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 50% 45% at 4% 6%, oklch(0.7 0.09 293 / 0.28), transparent 65%)," +
            "radial-gradient(ellipse 50% 50% at 98% 96%, oklch(0.75 0.07 293 / 0.25), transparent 60%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "radial-gradient(color-mix(in oklch, var(--color-primary) 14%, transparent) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage:
            "radial-gradient(ellipse 22% 30% at 2% 4%, black, transparent 70%), radial-gradient(ellipse 22% 30% at 98% 96%, black, transparent 70%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 22% 30% at 2% 4%, black, transparent 70%), radial-gradient(ellipse 22% 30% at 98% 96%, black, transparent 70%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-marketing px-5 sm:px-8">
        <SectionHeader
          level="2"
          align="center"
          eyebrow={connect.eyebrow}
          headline={
            <>
              {connect.headline}
              <span className="text-primary">{connect.headlineAccent}</span>
            </>
          }
          support={connect.support}
        />

        <div className="mx-auto mt-12 grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ordered.map((source, index) => (
            <div key={source.key} data-reveal={index % 3} className="min-w-0">
              <SourceCard source={source} />
            </div>
          ))}
        </div>

        <p data-reveal="0" className="mx-auto mt-8 flex max-w-prose-comfortable items-center justify-center gap-2.5 text-center text-sm text-surface-2-muted">
          <FileSpreadsheet className="size-4 shrink-0 text-primary" aria-hidden />
          {connect.footnote}
        </p>
      </div>
    </section>
  )
}
