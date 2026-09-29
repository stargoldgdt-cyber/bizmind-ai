import Link from "next/link"
import { ArrowRight, Sparkles } from "lucide-react"

import type { Finding, Tone } from "@/services/overview/findings"

/**
 * The single most relevant observation, given the reference layout's visual
 * prominence. No new text-generation: `story` (built by `contributionStory()`
 * from the profit bridge's own dollar deltas) is preferred when it exists,
 * since it names the actual amounts that moved profit, not just a share.
 * `items` (the plain-observation list `findings()` already produces) is the
 * fallback for a first period with nothing to compare against. Either way,
 * every word here traces back to a figure the database already computed.
 */

const TONE_RANK: Record<Tone, number> = { attention: 0, watch: 1, good: 2, info: 3 }

export function InsightCard({ story, items }: { story: Finding | null; items: Finding[] }) {
  const top = story ?? (items.length > 0 ? [...items].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])[0] : null)
  if (!top) return null

  return (
    <div className="flex flex-col justify-between gap-4 rounded-xl bg-surface-brand p-6 text-surface-brand-foreground">
      <div className="flex flex-col gap-3">
        <p className="inline-flex w-fit items-center gap-1.5 rounded-full bg-surface-brand-foreground/15 px-2.5 py-1 text-xs font-semibold">
          <Sparkles className="size-3.5" aria-hidden />
          BizMind insight
        </p>
        <div>
          <p className="text-lg font-bold tracking-tight">{top.title}</p>
          <p className="mt-1.5 text-sm text-surface-brand-muted">{top.body}</p>
        </div>
      </div>
      <Link
        href={top.href}
        className="inline-flex w-fit items-center gap-1.5 rounded-4xl bg-surface-brand-foreground px-4 py-2 text-sm font-semibold text-surface-brand hover:bg-surface-brand-foreground/90"
      >
        {top.action}
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </div>
  )
}
