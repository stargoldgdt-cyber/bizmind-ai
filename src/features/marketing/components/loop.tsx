import { Bell, ChevronRight, LayoutGrid, Link2, Sparkles, TrendingUp, Upload } from "lucide-react"
import type { ComponentType, SVGProps } from "react"

import { cn } from "cn"

import { loop } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * Icon + tile colour per step, matched to the owner's reference (2026-09-30).
 * `info`/`success` reuse the existing subtle tokens the same way the Problem
 * section's cost tiles already do (decorative categorisation, not a status
 * signal). Rose has no token equivalent -- the same marketing-only exception
 * already used for the Problem section's advertising tile (DECISIONS.md).
 */
const STEP_META: Record<
  string,
  { icon: ComponentType<SVGProps<SVGSVGElement>>; tile: string }
> = {
  upload: { icon: Upload, tile: "bg-primary/10 text-primary" },
  classify: { icon: LayoutGrid, tile: "bg-info-subtle text-info-strong" },
  match: { icon: Link2, tile: "bg-success-subtle text-success-strong" },
  profit: { icon: TrendingUp, tile: "bg-primary/10 text-primary" },
  explain: { icon: Sparkles, tile: "bg-rose-100 text-rose-600" },
  alert: { icon: Bell, tile: "bg-rose-100 text-rose-600" },
}

/**
 * The product loop as six connected steps, built to the owner's reference.
 *
 * A flexible row of `flex-1` tiles with small fixed-width (32px) connectors
 * between them -- not a mixed fixed+flexible grid. The Problem section's flow
 * row overflowed twice this way round when fixed-width nodes summed past
 * their container; here the tiles themselves stay flexible and only the tiny
 * connector is fixed, so there is nothing to overflow.
 */
export function Loop() {
  return (
    <Band level="2" id="loop" className="relative overflow-hidden">
      {/* Soft blob field + dot grid, matching the hero's background treatment. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 55% 50% at 92% 0%, oklch(0.7 0.09 293 / 0.3), transparent 65%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "radial-gradient(color-mix(in oklch, var(--color-primary) 14%, transparent) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage: "radial-gradient(ellipse 55% 60% at 100% 100%, black, transparent 72%)",
          WebkitMaskImage: "radial-gradient(ellipse 55% 60% at 100% 100%, black, transparent 72%)",
        }}
        aria-hidden
      />

      <div className="relative">
        <SectionHeader
          level="2"
          align="center"
          eyebrow={loop.eyebrow}
          headline={
            <>
              {loop.headline}
              <span className="text-primary">{loop.headlineAccent}</span>
            </>
          }
          support={loop.support}
        />

        {/* Desktop: one connected row, tiles flexible, connectors fixed-tiny. */}
        <div className="mt-14 hidden items-start lg:flex">
          {loop.steps.map((step, index) => {
            const meta = STEP_META[step.key]
            return (
              <div key={step.key} data-reveal={index} className="flex min-w-0 flex-1 items-start">
                <div className="min-w-0 flex-1 text-center">
                  <p className="font-mono text-[11px] tabular-nums text-surface-2-muted">
                    {String(index + 1).padStart(2, "0")}
                  </p>
                  <span
                    className={cn(
                      "mx-auto mt-2 flex size-12 items-center justify-center rounded-xl",
                      meta.tile
                    )}
                  >
                    <meta.icon className="size-5" aria-hidden />
                  </span>
                  <p className="mt-3 font-heading text-base font-bold tracking-tight">
                    {step.name}
                  </p>
                  <p className="mt-1 text-sm text-pretty text-surface-2-muted">{step.detail}</p>
                </div>

                {index < loop.steps.length - 1 && (
                  <div className="relative mt-12 flex w-10 shrink-0 items-center justify-center">
                    <span className="h-0.5 w-full rounded-full bg-primary/35" />
                    <span className="absolute inset-0 m-auto flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                      <ChevronRight className="size-3.5" aria-hidden />
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Tablet/mobile: no connecting rail, just a clean two-up grid. */}
        <div className="mt-12 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:hidden">
          {loop.steps.map((step, index) => {
            const meta = STEP_META[step.key]
            return (
              <div key={step.key} data-reveal={index % 2} className="flex min-w-0 items-start gap-4">
                <span
                  className={cn(
                    "flex size-12 shrink-0 items-center justify-center rounded-xl",
                    meta.tile
                  )}
                >
                  <meta.icon className="size-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="font-mono text-[11px] tabular-nums text-surface-2-muted">
                    {String(index + 1).padStart(2, "0")}
                  </p>
                  <p className="mt-0.5 font-heading text-base font-bold tracking-tight">
                    {step.name}
                  </p>
                  <p className="mt-1 text-sm text-pretty text-surface-2-muted">{step.detail}</p>
                </div>
              </div>
            )
          })}
        </div>

        <p data-reveal="0" className="mt-10 flex items-center justify-center gap-2.5 text-center text-sm text-surface-2-muted">
          <span className="size-2.5 shrink-0 rounded-full bg-primary" aria-hidden />
          {loop.footnote}
        </p>
      </div>
    </Band>
  )
}
