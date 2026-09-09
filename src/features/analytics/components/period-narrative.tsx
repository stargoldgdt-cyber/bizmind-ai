"use client"

import { useEffect, useState } from "react"
import { Sparkles } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { explainPeriodAction } from "@/features/analytics/actions"
import type { Narration } from "@/services/ai"

/**
 * "What happened, in plain language."
 *
 * Loads AFTER the page has rendered, on purpose. Every figure on the dashboard
 * is already on screen before this component asks for a word of explanation,
 * so a slow or unavailable model delays nothing an owner actually needs.
 *
 * When there is no explanation, this says why. Quietly disappearing would
 * invite the reading that something is wrong with the figures, when the truth
 * is the opposite: the figures are fine, and the prose about them was not good
 * enough to show.
 *
 * There is no "AI" branding, no orb, no glow. It is a paragraph about the
 * business.
 */
export function PeriodNarrative({ range }: { range: string }) {
  const [state, setState] = useState<Narration | "loading">("loading")

  // No reset-to-loading here: the dashboard mounts this with key={range}, so
  // changing the period remounts the component and the initial state is
  // already "loading". Setting state synchronously in an effect would cause a
  // cascading render for no gain.
  useEffect(() => {
    let cancelled = false

    explainPeriodAction({ range })
      .then((result) => {
        if (!cancelled) setState(result)
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            ok: false,
            reason: "failed",
            message:
              "The explanation could not be produced just now. Your figures above are unaffected.",
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [range])

  // Nothing to say and nothing worth explaining why. An empty period does not
  // need a box telling the owner it is empty; the dashboard already does.
  if (state !== "loading" && !state.ok && state.reason === "refused") return null

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          What happened, in plain language
        </CardTitle>
      </CardHeader>

      <CardContent>
        {state === "loading" ? (
          <div className="space-y-2" aria-live="polite" aria-busy="true">
            <span className="sr-only">Writing an explanation of these figures…</span>
            <span className="block h-3 w-full animate-pulse rounded bg-accent" />
            <span className="block h-3 w-11/12 animate-pulse rounded bg-accent" />
            <span className="block h-3 w-4/5 animate-pulse rounded bg-accent" />
          </div>
        ) : state.ok ? (
          <div className="space-y-3 text-sm leading-relaxed">
            {state.text
              .split(/\n{2,}/)
              .map((paragraph) => paragraph.trim())
              .filter((paragraph) => paragraph !== "")
              .map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}

            <p className="pt-1 text-xs text-muted-foreground">
              Written from the figures above, which are calculated from your own
              records. Every number here was checked against them before this was
              shown.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{state.message}</p>
        )}
      </CardContent>
    </Card>
  )
}
