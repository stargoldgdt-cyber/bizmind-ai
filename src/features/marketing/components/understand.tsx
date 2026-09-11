import { Calculator } from "lucide-react"

import { MetricCard } from "@/features/analytics/components/metric-card"

import { understand } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * Understand.
 *
 * THESE ARE THE PRODUCT'S OWN COMPONENTS.
 *
 * `MetricCard` is imported from `src/features/analytics` — the same file the
 * dashboard renders. Not a copy, not a marketing lookalike. It brings its own
 * tooltip explaining how the figure was calculated, and its own warning slot
 * for a figure whose inputs are incomplete.
 *
 * That reuse is the point. A landing page that redraws the product can drift
 * from it; this one cannot, because if the card changes shape here it changed
 * shape in the app too.
 *
 * The layout is a bento rather than a row: the pledge panel is the argument
 * the cards are evidence for, so it gets the width.
 */
export function Understand() {
  return (
    <Band level="1" id="understand">
      <SectionHeader
        level="1"
        eyebrow={understand.eyebrow}
        headline={understand.headline}
        support={understand.support}
      />

      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        {understand.metrics.map((metric) => (
          <MetricCard
            key={metric.label}
            label={metric.label}
            value={metric.value}
            change={metric.change}
            higherIsBetter={metric.higherIsBetter}
            explanation={metric.explanation}
            warning={metric.warning}
          />
        ))}
      </div>

      {/*
        The claim the cards above are evidence for. On its own band-within-a-
        band so it reads as the conclusion rather than a fourth card.
      */}
      <div className="mt-4 flex flex-col gap-5 rounded-2xl border border-surface-1-border bg-surface-2 p-6 sm:flex-row sm:items-center sm:gap-8 sm:p-8">
        <span
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-700"
          aria-hidden
        >
          <Calculator className="size-5" />
        </span>

        <div>
          <h3 className="font-heading text-lg font-semibold tracking-tight">
            {understand.pledge.title}
          </h3>
          <p className="mt-1.5 max-w-prose-comfortable text-surface-2-muted">
            {understand.pledge.body}
          </p>
        </div>
      </div>
    </Band>
  )
}
