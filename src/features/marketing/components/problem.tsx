import {
  ArrowRight,
  BarChart3,
  Calendar,
  ChevronDown,
  ChevronRight,
  Megaphone,
  Package,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  Wallet,
} from "lucide-react"

import { cn } from "cn"

import { problem } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * The tension, rebuilt to the owner's supplied design (2026-09-30,
 * dashboard-handoff.zip): three headline figures, then a full sales-to-
 * payout flow beside an AI insight panel, replacing the earlier plain
 * three-row ledger.
 *
 * MULTICOLOURED TILES, A NAMED MARKETING-ONLY EXCEPTION
 * --------------------------------------------------------
 * Gross Sales/Orders/Contribution map to the product's own violet/success/
 * danger tokens. Fulfilment, advertising and refunds don't have a semantic
 * home in the product's four-slot status palette, so fulfilment reuses
 * `warning` (closest to the reference's orange) and refunds reuses `info`
 * (the reference's blue); advertising has no token at all and is the one
 * genuinely new colour, a scoped Tailwind rose -- same shape as the hero's
 * named exceptions (DECISIONS.md), never reaching the product.
 *
 * THE FLOW STAYS A ROW ON LARGE SCREENS, STACKS ON SMALL ONES
 * ----------------------------------------------------------------
 * The reference keeps its seven-column flow at every width by shrinking it
 * with a CSS transform, which still risks horizontal scroll on a narrow
 * phone. The owner's own instruction was "no clipping or horizontal
 * overflow", so below `lg` this renders as a vertical sequence instead --
 * the same figures, the same order, no transform tricks.
 */

/**
 * A CSS custom property doesn't reliably resolve when set as a raw SVG
 * `stop-color` attribute (unlike a `style` property), so each sparkline
 * takes a real hex colour and its own stable gradient id -- the earlier
 * version generated the id from the colour string, which produced an
 * invalid `url(#...)` reference for a `var(...)` value and silently fell
 * back to a solid black fill.
 */
function Sparkline({ id, area, line, color }: { id: string; area: string; line: string; color: string }) {
  return (
    <svg viewBox="0 0 142 68" className="hidden h-14 w-28 shrink-0 lg:block" aria-hidden>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop stopColor={color} stopOpacity="0.2" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${id})`} className="draw-fade" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" pathLength={1} className="draw-line" />
    </svg>
  )
}

/** Real hex, matching --primary/--success/--danger's light-mode values -- this hero band is light-only, same as the marketplace logo dots in hero.tsx. */
const FIGURE_SPARKS: Record<string, { area: string; line: string; color: string }> = {
  gross: {
    area: "M2 51 C14 43 18 31 27 36 S39 43 49 32 S64 27 77 17 S89 12 98 22 S112 25 124 24 S134 17 141 16 V68 H2Z",
    line: "M2 51 C14 43 18 31 27 36 S39 43 49 32 S64 27 77 17 S89 12 98 22 S112 25 124 24 S134 17 141 16",
    color: "#6d28d9",
  },
  orders: {
    area: "M2 54 C15 40 22 34 32 34 S47 39 58 30 S76 22 83 17 S94 21 105 22 S119 26 129 21 S136 18 141 17 V68 H2Z",
    line: "M2 54 C15 40 22 34 32 34 S47 39 58 30 S76 22 83 17 S94 21 105 22 S119 26 129 21 S136 18 141 17",
    color: "#15803d",
  },
  contribution: {
    area: "M2 42 C10 31 17 21 23 9 S37 24 46 28 S59 42 67 31 S78 27 87 35 S101 42 109 44 S122 50 141 49 V68 H2Z",
    line: "M2 42 C10 31 17 21 23 9 S37 24 46 28 S59 42 67 31 S78 27 87 35 S101 42 109 44 S122 50 141 49",
    color: "#b91c1c",
  },
}

const FIGURE_ICON = { gross: BarChart3, orders: ShoppingBag, contribution: Wallet } as const
const FIGURE_TILE: Record<string, string> = {
  violet: "bg-primary/10 text-primary",
  green: "bg-success-subtle text-success-strong",
  red: "bg-danger-subtle text-danger-strong",
}
const FIGURE_VALUE: Record<string, string> = {
  violet: "text-primary",
  green: "text-success-strong",
  red: "text-danger-strong",
}

/** Fulfilment/advertising/refunds share this icon + colour everywhere they appear (cost cards and the insight drivers). */
const COST_META = {
  fulfilment: { icon: Package, tile: "bg-warning-subtle text-warning-strong" },
  advertising: { icon: Megaphone, tile: "bg-rose-100 text-rose-600" },
  refunds: { icon: RotateCcw, tile: "bg-info-subtle text-info-strong" },
} as const

export function Problem() {
  return (
    <Band level="1" id="problem">
      <SectionHeader
        level="1"
        eyebrow={problem.eyebrow}
        headline={
          <>
            {problem.headline}
            <br />
            {problem.headlineLead}
            <span className="text-primary">{problem.headlineAccent}</span>
          </>
        }
        support={problem.support}
        align="center"
      />

      {/* ---- three headline figures ---- */}
      <div className="mx-auto mt-12 grid max-w-5xl gap-4 sm:grid-cols-3">
        {problem.figures.map((figure, index) => {
          const Icon = FIGURE_ICON[figure.key as keyof typeof FIGURE_ICON]
          const spark = FIGURE_SPARKS[figure.key]
          return (
            <div
              key={figure.key}
              data-reveal={index}
              className="flex min-w-0 items-start justify-between gap-3 rounded-2xl border border-surface-1-border bg-surface-1 p-5 shadow-xs"
            >
              <div className="flex min-w-0 gap-3.5">
                <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", FIGURE_TILE[figure.tone])}>
                  <Icon className="size-5" aria-hidden />
                </span>
                <div>
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-surface-1-foreground">
                    {figure.label}
                    <span
                      className="flex size-4 items-center justify-center rounded-full border border-surface-1-border text-[10px] text-surface-1-muted"
                      aria-hidden
                    >
                      i
                    </span>
                  </p>
                  <p className={cn("mt-2.5 flex items-center gap-2 font-mono text-3xl font-extrabold tracking-tighter", FIGURE_VALUE[figure.tone])}>
                    {figure.change}
                    <span className={cn("flex size-6 items-center justify-center rounded-full text-sm", FIGURE_TILE[figure.tone])}>
                      {figure.direction === "up" ? "↗" : "↘"}
                    </span>
                  </p>
                  <p className="mt-1.5 text-sm font-semibold text-surface-1-muted">
                    {figure.value}
                    <span className="block text-xs font-normal text-surface-1-muted">vs last period</span>
                  </p>
                </div>
              </div>
              {spark && <Sparkline id={figure.key} {...spark} />}
            </div>
          )
        })}
      </div>

      {/* ---- "so where did it go" ---- */}
      <div data-reveal="0" className="mx-auto mt-16 max-w-2xl text-center">
        <h3 className="font-heading text-3xl font-extrabold tracking-tight text-balance">{problem.question}</h3>
        <p className="mt-2 text-surface-1-muted">{problem.questionSupport}</p>
      </div>

      {/*
        ---- the flow, and the insight beside it ----
        Side by side only from xl (1280px): measured live, 2026-09-30 -- at
        lg (1024px) the flow panel's own share of the row came out to ~560px,
        and the horizontal flow below needs a genuine ~700px+ to lay out
        three nodes and three cost cards without squeezing the cost column
        to nothing. Rather than keep shrinking numbers to fit a width that's
        fundamentally too narrow for this much content, the two-column
        layout (and the flow's own horizontal row further down) waits for
        the width where it actually has room, and stacks single-column
        below that -- still the full design, just read top to bottom.
      */}
      <div className="mx-auto mt-8 grid max-w-7xl items-stretch gap-4 xl:grid-cols-[2fr_1fr]">
        {/* From Sales to Payout */}
        <div data-reveal="0" className="min-w-0 rounded-3xl border border-surface-1-border bg-surface-1 p-6 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h4 className="font-heading text-xl font-extrabold tracking-tight sm:text-2xl">{problem.flow.panelTitle}</h4>
              <p className="mt-1 max-w-sm text-sm text-surface-1-muted">{problem.flow.panelSupport}</p>
            </div>
            <span className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-surface-1-border px-3.5 text-xs font-semibold text-surface-1-foreground">
              <Calendar className="size-3.5 text-surface-1-muted" aria-hidden />
              {problem.flow.month}
              <ChevronDown className="size-3.5 text-surface-1-muted" aria-hidden />
            </span>
          </div>

          {/*
            Large screens: one horizontal sequence, laid out as a CSS grid whose node
            columns are a bounded `minmax(0, …)` rather than a fixed, non-shrinking
            flex width. A flex row of unshrinking nodes can add up to more than the
            panel actually has and spill out over whatever sits beside it (caught
            live, 2026-09-30: the Contribution node was bleeding into the insight
            panel) -- a grid's tracks are computed to fit the container, so the row
            physically cannot exceed it, on any width lg: applies to.
            Below lg: a vertical stack, so nothing clips or scrolls sideways either.
          */}
          <div className="mt-7 hidden items-stretch gap-3 xl:grid xl:grid-cols-[minmax(0,140px)_auto_minmax(0,1fr)_auto_minmax(0,140px)_auto_minmax(0,140px)]">
            <FlowNode icon={ShoppingBag} tone="violet" label={problem.flow.grossSales.label} value={problem.flow.grossSales.value} />
            <FlowArrow />
            <div className="grid min-w-0 gap-3">
              {problem.flow.costs.map((cost) => (
                <CostRow key={cost.key} cost={cost} />
              ))}
            </div>
            <FlowArrow />
            <FlowNode icon={Wallet} tone="violet" label={problem.flow.netPayout.label} value={problem.flow.netPayout.value} note={problem.flow.netPayout.note} />
            <FlowArrow />
            <FlowNode icon={BarChart3} tone="green" label={problem.flow.contribution.label} value={problem.flow.contribution.value} note={problem.flow.contribution.note} />
          </div>

          <div className="mt-7 flex flex-col gap-3 xl:hidden">
            <FlowNode icon={ShoppingBag} tone="violet" label={problem.flow.grossSales.label} value={problem.flow.grossSales.value} />
            {problem.flow.costs.map((cost) => (
              <CostRow key={cost.key} cost={cost} />
            ))}
            <FlowNode icon={Wallet} tone="violet" label={problem.flow.netPayout.label} value={problem.flow.netPayout.value} note={problem.flow.netPayout.note} />
            <FlowNode icon={BarChart3} tone="green" label={problem.flow.contribution.label} value={problem.flow.contribution.value} note={problem.flow.contribution.note} />
          </div>
        </div>

        {/* BizMind AI Insight */}
        <div data-reveal="1" className="min-w-0 rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/8 to-primary/3 p-6 sm:p-7">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <Sparkles className="size-4" aria-hidden />
            {problem.insight.label}
          </p>
          <h4 className="mt-3 font-heading text-2xl leading-tight font-extrabold tracking-tight text-balance">
            {problem.insight.headline}
            <br />
            <span className="text-primary">{problem.insight.headlineAccent}</span>
            {problem.insight.headlineTail}
          </h4>
          <p className="mt-2.5 text-sm text-pretty text-surface-1-muted">{problem.insight.body}</p>

          <div className="mt-4 divide-y divide-surface-1-border rounded-xl border border-surface-1-border bg-surface-1">
            {problem.insight.drivers.map((driver) => {
              const meta = COST_META[driver.key as keyof typeof COST_META]
              return (
                <div key={driver.key} className="flex items-start gap-3 px-3.5 py-2.5">
                  <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", meta.tile)}>
                    <meta.icon className="size-4" aria-hidden />
                  </span>
                  <span className="mt-1.5 min-w-0 flex-1 text-pretty text-xs text-surface-1-muted">{driver.label}</span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-bold text-primary">{driver.stat}</span>
                    <span className="block text-[11px] text-surface-1-muted">{driver.note}</span>
                  </span>
                </div>
              )
            })}
          </div>

          <a
            href={problem.insight.cta.href}
            className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-4xl bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 sm:w-auto"
          >
            {problem.insight.cta.label}
            <ArrowRight className="size-4" aria-hidden />
          </a>
        </div>
      </div>
    </Band>
  )
}

function FlowArrow() {
  return (
    <div className="hidden shrink-0 items-center justify-center xl:flex">
      <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <ChevronRight className="size-4" aria-hidden />
      </span>
    </div>
  )
}

function FlowNode({
  icon: Icon,
  tone,
  label,
  value,
  note,
}: {
  icon: typeof ShoppingBag
  tone: "violet" | "green"
  label: string
  value: string
  note?: string
}) {
  return (
    <div
      className={cn(
        "flex min-h-32 min-w-0 w-full flex-col justify-center rounded-2xl border p-4",
        tone === "violet" ? "border-primary/20 bg-primary/8" : "border-success/25 bg-success-subtle"
      )}
    >
      <span className={cn("flex size-9 items-center justify-center rounded-lg", tone === "violet" ? "bg-primary/15 text-primary" : "bg-success/15 text-success-strong")}>
        <Icon className="size-4" aria-hidden />
      </span>
      <p className="mt-2.5 truncate text-xs font-semibold text-surface-1-muted">{label}</p>
      <p className="mt-0.5 truncate font-mono text-base font-extrabold tracking-tight text-surface-1-foreground">{value}</p>
      {note && <p className="mt-1 text-[11px] text-pretty text-surface-1-muted">{note}</p>}
    </div>
  )
}

/**
 * Three lines, not four segments sharing one or two rows. Live measurement,
 * 2026-09-30: even split across two rows, the value ("−AED 34,985") and the
 * percentage-plus-note ("19% of net sales") each needed ~90px and only had
 * ~130px to share, so the value truncated down to two characters. In the
 * flow's compact cost column (~150-190px at the widths this row actually
 * renders at) there's height to spare but not width to share, so the label,
 * the value and the percentage each get their own full-width line instead
 * of splitting any of it three or four ways.
 */
function CostRow({ cost }: { cost: (typeof problem.flow.costs)[number] }) {
  const meta = COST_META[cost.key as keyof typeof COST_META]
  return (
    <div className="min-w-0 rounded-xl border border-surface-1-border bg-surface-1 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", meta.tile)}>
          <meta.icon className="size-3.5" aria-hidden />
        </span>
        <p className="truncate text-xs text-surface-1-muted">{cost.label}</p>
      </div>
      <p className="mt-1.5 truncate font-mono text-sm font-bold text-surface-1-foreground">{cost.value}</p>
      <p className="mt-0.5 truncate text-xs text-surface-1-muted">
        <span className="font-bold text-surface-1-foreground">{cost.pct}</span> {cost.pctNote}
      </p>
    </div>
  )
}
