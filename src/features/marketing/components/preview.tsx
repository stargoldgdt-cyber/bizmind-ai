"use client"

import { useState } from "react"
import { AlertTriangle, Eye, LayoutGrid, Lock, Store, Zap } from "lucide-react"
import type { ComponentType, SVGProps } from "react"

import { cn } from "cn"

import { preview } from "../content"
import { SectionHeader } from "./section"
import { ProfitConsole } from "./profit-console"

/**
 * A closer look: two real panels, tabbed.
 *
 * WHY TABS AND NOT A VIDEO
 * ------------------------
 * There is no recorded product tour yet, and a disabled play button saying
 * "coming soon" is exactly the kind of unfinished-looking UI the homepage
 * should never show (owner direction, 2026-09-29). A tab switcher between
 * two real panels is complete today -- both press, both work, neither is a
 * placeholder for something that doesn't exist -- and it is honest: this is
 * markup, the same as every other product visual on this page, not a
 * recording.
 *
 * READY FOR A REAL VIDEO LATER
 * -----------------------------
 * When a recording exists, it becomes a third tab (or replaces this section
 * outright) without moving anything else on the page -- the section's id,
 * position and header never have to change for that.
 *
 * LIGHT, MATCHED TO THE OWNER'S REFERENCE (2026-09-30)
 * -------------------------------------------------------
 * Previously an all-dark `surface-3` band -- the one remaining dark section
 * after Hero, Problem and Loop all moved light. The owner's reference puts
 * this section on the same lavender-blob band those three already use, so
 * this rebuild follows that band, not a fresh design of its own.
 */
const MARKETPLACES = [
  { name: "noon.ae", sales: "138,240", share: "75%", costs: "39.8%", width: "w-[75%]", weak: true },
  { name: "Amazon.ae", sales: "46,080", share: "25%", costs: "32.1%", width: "w-[25%]", weak: false },
] as const

const REASON_ICON: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  view: Eye,
  sync: Zap,
  insight: Lock,
}

function MarketplaceCompare() {
  return (
    <div className="overflow-hidden rounded-3xl border border-surface-1-border bg-surface-1 shadow-[0_30px_60px_-35px_rgba(76,29,149,0.3)]">
      <div className="flex items-center justify-between border-b border-surface-1-border px-4 py-3.5 sm:px-6">
        <p className="font-mono text-[11px] tracking-wider text-surface-1-muted uppercase">By marketplace · demo</p>
        <p className="hidden font-mono text-[11px] text-surface-1-muted sm:block">Last 3 months</p>
      </div>

      <div className="p-4 sm:p-6">
        <div className="flex items-baseline justify-between">
          <p className="font-mono text-[11px] tracking-wider text-surface-1-muted uppercase">Share of sales</p>
          <p className="font-mono text-[11px] text-surface-1-muted">Costs, % of sales</p>
        </div>

        <ul className="mt-3.5 space-y-4">
          {MARKETPLACES.map((m) => (
            <li key={m.name}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate">
                  {m.name}
                  <span className="ml-2 font-mono text-[11px] text-surface-1-muted">{m.share} of sales</span>
                </span>
                <span className="flex shrink-0 items-baseline gap-3 font-mono text-xs tabular-nums">
                  <span className="text-surface-1-muted">{m.sales}</span>
                  <span className={cn("w-12 text-right", m.weak ? "text-warning-strong" : "text-surface-1-foreground")}>
                    {m.costs}
                  </span>
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className={cn("h-full rounded-full", m.width, m.weak ? "bg-warning" : "bg-primary")} />
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex gap-3 rounded-xl border border-warning/30 bg-warning-subtle p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-strong" aria-hidden />
          <div>
            <p className="text-sm font-medium">noon keeps 39.8% of what it sells for you.</p>
            <p className="mt-1 text-xs text-surface-1-muted">
              Fulfilment there rose faster than sales this period — the same figures, one marketplace at a time.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Preview() {
  const [active, setActive] = useState(0)

  return (
    <section
      id="preview"
      className="relative overflow-hidden bg-surface-1 py-section-md text-surface-1-foreground"
      style={{ scrollMarginTop: "4rem" }}
    >
      {/* Soft blob field + dot grid, matching Hero, Problem and Loop's background treatment. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 55% 45% at 6% 6%, oklch(0.7 0.09 293 / 0.3), transparent 65%)," +
            "radial-gradient(ellipse 45% 40% at 100% 95%, oklch(0.75 0.07 293 / 0.25), transparent 60%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "radial-gradient(color-mix(in oklch, var(--color-primary) 14%, transparent) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage: "radial-gradient(ellipse 45% 55% at 0% 100%, black, transparent 72%)",
          WebkitMaskImage: "radial-gradient(ellipse 45% 55% at 0% 100%, black, transparent 72%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-marketing px-5 sm:px-8">
        <SectionHeader
          level="2"
          eyebrow={preview.eyebrow}
          headline={
            <>
              {preview.headline}
              <span className="text-primary">{preview.headlineAccent}</span>
            </>
          }
          support={preview.support}
          align="center"
        />

        <div data-reveal="0" className="mx-auto mt-8 flex w-full max-w-full flex-col gap-1.5 rounded-3xl border border-surface-2-border bg-surface-1 p-2 sm:w-fit sm:flex-row sm:rounded-full">
          {preview.tabs.map((tab, index) => {
            const Icon = index === 0 ? LayoutGrid : Store
            return (
              <button
                key={tab.name}
                type="button"
                onClick={() => setActive(index)}
                aria-pressed={active === index}
                className={cn(
                  "flex items-center gap-3 rounded-2xl px-4 py-2.5 text-left transition-colors sm:rounded-full",
                  active === index ? "bg-primary text-primary-foreground" : "text-surface-1-foreground hover:bg-surface-2"
                )}
              >
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-xl",
                    active === index ? "bg-primary-foreground/15" : "bg-primary/10 text-primary"
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{tab.name}</span>
                  <span className={cn("block text-xs", active === index ? "text-primary-foreground/75" : "text-surface-1-muted")}>
                    {tab.detail}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <div data-reveal="1" className="mt-8">{active === 0 ? <ProfitConsole /> : <MarketplaceCompare />}</div>

        <div className="mt-12 grid gap-x-6 gap-y-8 sm:grid-cols-3">
          {preview.reasons.map((reason, index) => {
            const Icon = REASON_ICON[reason.key]
            return (
              <div key={reason.key} data-reveal={index} className="flex min-w-0 items-start gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="font-heading text-base font-bold tracking-tight">{reason.name}</p>
                  <p className="mt-1 text-sm text-pretty text-surface-2-muted">{reason.detail}</p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
