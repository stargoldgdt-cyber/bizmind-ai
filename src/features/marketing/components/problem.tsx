import { ArrowDown } from "lucide-react"

import { cn } from "cn"

import { problem } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * The tension.
 *
 * Three figures that cannot all be good news, then the question every owner
 * actually asks, then the answer their dashboard never gives them.
 *
 * It is built as one vertical movement rather than a row of cards because the
 * argument has an order: you notice, you ask, you find out. A three-card grid
 * would present those as alternatives rather than as a sequence.
 */
export function Problem() {
  return (
    <Band level="1" id="problem">
      <SectionHeader
        level="1"
        eyebrow={problem.eyebrow}
        headline={problem.headline}
        support={problem.support}
        align="center"
      />

      <div className="mx-auto mt-14 max-w-3xl">
        {/* What the dashboard shows. Two greens and a red. */}
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-surface-1-border bg-surface-1-border">
          {problem.figures.map((figure) => (
            <div key={figure.label} className="bg-surface-1 px-4 py-6 text-center sm:px-6 sm:py-8">
              <p className="text-xs text-surface-1-muted sm:text-sm">{figure.label}</p>
              <p
                className={cn(
                  "mt-2 font-mono text-2xl font-semibold tabular-nums sm:text-3xl",
                  figure.tone === "up" ? "text-success" : "text-danger"
                )}
              >
                {figure.value}
              </p>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center py-7">
          <p className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
            {problem.question}
          </p>
          <ArrowDown className="mt-4 size-5 text-surface-1-muted" aria-hidden />
        </div>

        {/*
          The answer, as a short ledger. Deliberately plainer than the figures
          above: the reveal is the content, so it does not need decoration.
        */}
        <ul className="overflow-hidden rounded-2xl border border-surface-1-border">
          {problem.answer.map((row) => (
            <li
              key={row.label}
              className="flex flex-col gap-1 border-b border-surface-1-border px-5 py-4 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 sm:px-6"
            >
              <span className="font-medium">{row.label}</span>
              <span className="text-sm text-surface-1-muted sm:text-right">
                {row.detail}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Band>
  )
}
