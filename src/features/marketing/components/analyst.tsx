import { Info } from "lucide-react"

import { LogoMark } from "@/components/brand/logo"

import { analyst } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * Ask BizMind.
 *
 * WHY THIS DOES NOT LOOK LIKE A CHAT APP
 * --------------------------------------
 * A bubble thread reads as "we put a chatbot on it", and invites the reader to
 * assume the answer was generated the way a chatbot generates one. What is
 * actually happening is the opposite: the figures are computed first, in the
 * database, and the model is only allowed to narrate the ones it was handed.
 *
 * So the answer is drawn with the figures it cited attached BENEATH it, as a
 * ledger. The reader can see the working. That is what separates this from a
 * confident paragraph of invented numbers, and it is the single most important
 * thing this page has to communicate about the AI.
 *
 * The caveat line is not a disclaimer. It is the model refusing to let a
 * margin stand unqualified when the cost data behind it is incomplete.
 */
export function Analyst() {
  const { exchange } = analyst

  return (
    <Band level="3" id="analyst">
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <SectionHeader
            level="3"
            eyebrow={analyst.eyebrow}
            headline={analyst.headline}
            support={analyst.support}
          />
        </div>

        <div className="lg:col-span-7">
          <div className="rounded-2xl border border-surface-3-border bg-surface-3-raised">
            {/* The question, in the owner's own words. */}
            <div className="border-b border-surface-3-border px-5 py-4 sm:px-6 sm:py-5">
              <p className="font-mono text-[11px] tracking-wider text-surface-3-muted uppercase">
                You asked
              </p>
              <p className="mt-2 font-heading text-lg font-medium tracking-tight sm:text-xl">
                {exchange.question}
              </p>
            </div>

            <div className="px-5 py-5 sm:px-6 sm:py-6">
              <div className="flex items-center gap-2.5">
                <LogoMark className="size-5" />
                <p className="font-mono text-[11px] tracking-wider text-surface-3-muted uppercase">
                  BizMind
                </p>
              </div>

              <p className="mt-3.5 text-pretty">{exchange.answer}</p>

              {/* The working. Every figure in the answer, and nothing else. */}
              <dl className="mt-5 grid gap-px overflow-hidden rounded-xl border border-surface-3-border bg-surface-3-border sm:grid-cols-3">
                {exchange.cited.map((figure) => (
                  <div key={figure.label} className="bg-surface-3-raised px-4 py-3">
                    <dt className="text-[11px] text-surface-3-muted">{figure.label}</dt>
                    <dd className="mt-1 font-mono text-base font-semibold tabular-nums">
                      {figure.value}
                    </dd>
                  </div>
                ))}
              </dl>

              <p className="mt-4 flex gap-2.5 text-xs text-surface-3-muted">
                <Info className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>{exchange.caveat}</span>
              </p>
            </div>
          </div>

          <p className="mt-4 text-sm text-surface-3-muted">
            Every figure above was calculated before the question was asked.
            BizMind explains them — it never produces one.
          </p>
        </div>
      </div>
    </Band>
  )
}
