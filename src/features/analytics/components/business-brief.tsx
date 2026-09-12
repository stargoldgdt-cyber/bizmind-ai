"use client"

import { useEffect, useState } from "react"
import { ArrowRight, Eye, Sparkles, TrendingUp } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { briefForPeriodAction } from "@/features/analytics/actions"
import type { BriefResult } from "@/services/ai"

/**
 * The business brief.
 *
 * WHAT HAPPENED · WHY IT MATTERS · WHAT TO WATCH · WHAT TO DO NEXT
 *
 * FOUR SECTIONS, NOT FOUR PARAGRAPHS.
 * An owner skims. A brief that buries "these profit figures are overstated"
 * in the middle of a paragraph gets acted on without the caveat — which is the
 * exact failure this product exists to prevent. Under a heading it cannot be
 * missed, and "what to do next" can be found without reading the rest.
 *
 * If the model does not produce all four sections, nothing is shown but the
 * reason. A half-brief is not repaired here: filling in a missing section
 * would be this component writing the business's analysis itself.
 *
 * LOADS AFTER THE PAGE. Every figure is on screen before this asks for a word
 * about them, so a slow or unavailable model delays nothing. No orb, no glow,
 * no "AI" branding: it is a note about the business.
 */
export function BusinessBrief({ filters }: { filters: Record<string, string> }) {
  const [state, setState] = useState<BriefResult | "loading">("loading")

  // No reset-to-loading: the dashboard mounts this with a key covering every
  // filter, so a filter change remounts it and "loading" is the initial state.
  useEffect(() => {
    let cancelled = false

    briefForPeriodAction(filters)
      .then((result) => {
        if (!cancelled) setState(result)
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            ok: false,
            reason: "failed",
            message:
              "The brief could not be produced just now. Your figures above are unaffected.",
          })
        }
      })

    return () => {
      cancelled = true
    }
    // The object identity changes every render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters)])

  // An empty period does not need a box saying so; the dashboard already does.
  if (state !== "loading" && !state.ok && state.reason === "refused") return null

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          Your brief
        </CardTitle>
      </CardHeader>

      <CardContent>
        {state === "loading" ? (
          <div className="space-y-2" aria-live="polite" aria-busy="true">
            <span className="sr-only">Writing a brief on these figures…</span>
            <span className="block h-3 w-full animate-pulse rounded bg-accent" />
            <span className="block h-3 w-11/12 animate-pulse rounded bg-accent" />
            <span className="block h-3 w-4/5 animate-pulse rounded bg-accent" />
          </div>
        ) : state.ok ? (
          <div className="space-y-5">
            <Section icon={TrendingUp} title="What happened" body={state.brief.happened} />
            <Section icon={ArrowRight} title="Why it matters" body={state.brief.matters} />
            <Section icon={Eye} title="What to watch" body={state.brief.watch} />

            <div>
              <SectionTitle title="What to do next" />
              <ul className="mt-2 space-y-2">
                {state.brief.next.map((action, index) => (
                  <li key={index} className="flex gap-2.5 text-sm leading-relaxed">
                    <span
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-600"
                      aria-hidden
                    />
                    <span>{action}</span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              Written from the figures above, which are calculated from your own
              records. Every number here was checked against them before this
              was shown.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        )}
      </CardContent>
    </Card>
  )
}

function SectionTitle({ title }: { title: string }) {
  return (
    <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {title}
    </h3>
  )
}

function Section({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof TrendingUp
  title: string
  body: string
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden />
        <SectionTitle title={title} />
      </div>
      <div className="mt-1.5 space-y-2 text-sm leading-relaxed">
        {body
          .split(/\n{2,}/)
          .map((paragraph) => paragraph.trim())
          .filter((paragraph) => paragraph !== "")
          .map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
      </div>
    </div>
  )
}
