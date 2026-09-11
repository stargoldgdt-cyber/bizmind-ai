import { cn } from "cn"

import { loop } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * The product loop as one continuous rail.
 *
 * Six steps drawn on a single line with a marker where reporting ends and
 * deciding begins — because that boundary is the entire pitch. Rendering them
 * as six cards would make them look like six features of equal weight, which
 * is exactly the wrong reading.
 *
 * On a phone the rail turns vertical and the marker becomes a horizontal rule,
 * so the same argument survives the reflow. It is not a scaled-down desktop
 * row, and it does not scroll sideways.
 */
export function Loop() {
  return (
    <Band level="2" id="loop">
      <SectionHeader
        level="2"
        eyebrow={loop.eyebrow}
        headline={loop.headline}
        support={loop.support}
      />

      <ol className="mt-14 grid gap-0 sm:grid-cols-2 lg:grid-cols-6">
        {loop.steps.map((step, index) => {
          const isDecision = index >= loop.divider

          return (
            <li
              key={step.name}
              className={cn(
                "relative border-surface-2-border py-5 lg:border-t lg:py-0 lg:pt-6",
                // Vertical hairlines between steps on mobile, a shared top
                // rule on desktop. The rail IS the border.
                "border-b last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0 lg:border-b-0"
              )}
            >
              {/* The marker sits on the rail itself, not floating beside it. */}
              <span
                className={cn(
                  "absolute -top-[5px] left-0 hidden size-2.5 rounded-full lg:block",
                  isDecision ? "bg-primary" : "bg-surface-2-border"
                )}
                aria-hidden
              />

              <div className="lg:pr-5">
                <p className="font-mono text-[11px] tabular-nums text-surface-2-muted">
                  {String(index + 1).padStart(2, "0")}
                </p>
                <p
                  className={cn(
                    "mt-1 font-heading text-base font-semibold tracking-tight",
                    isDecision && "text-primary"
                  )}
                >
                  {step.name}
                </p>
                <p className="mt-1 text-sm text-surface-2-muted">{step.detail}</p>
              </div>
            </li>
          )
        })}
      </ol>

      <p className="mt-8 flex items-center gap-2.5 text-sm text-surface-2-muted">
        <span className="size-2.5 rounded-full bg-primary" aria-hidden />
        Where a report stops and a decision starts.
      </p>
    </Band>
  )
}
