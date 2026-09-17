"use client"

import { useState, useTransition } from "react"
import { ArrowRight, Info, Loader2 } from "lucide-react"

import { cn } from "cn"
import { askLedgerQuestionAction } from "@/features/ledger-ask/actions"
import type { LedgerAnswer, LedgerQuestion } from "@/services/ai"

/**
 * Ask BizMind about the marketplaces (GCC Phase 9).
 *
 * A fixed list of questions, each bound to verified ledger figures, for the
 * same reason as the legacy panel: a free-text box invites answers with
 * numbers nobody computed. The figures the answer is built on are always
 * shown below it, so the answer can be checked -- and so the figures are
 * there even when no written answer is.
 */
export function LedgerAskPanel({
  questions,
  month,
}: {
  questions: { key: LedgerQuestion; ask: string }[]
  month: string
}) {
  const [active, setActive] = useState<LedgerQuestion | null>(null)
  const [answer, setAnswer] = useState<LedgerAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const ask = (key: LedgerQuestion) =>
    startTransition(async () => {
      setActive(key)
      setAnswer(null)
      setError(null)
      const result = await askLedgerQuestionAction({ question: key, month })
      if (result.ok) setAnswer(result.answer)
      else setError(result.error)
    })

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <ul className="grid content-start gap-2">
        {questions.map((q) => (
          <li key={q.key}>
            <button
              type="button"
              disabled={pending}
              onClick={() => ask(q.key)}
              aria-pressed={active === q.key}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors",
                active === q.key ? "border-primary bg-accent" : "border-border bg-card hover:bg-muted"
              )}
            >
              {q.ask}
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      <section className="min-h-48 rounded-xl border border-border bg-card p-5" aria-live="polite">
        {pending ? (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Reading your figures…
          </p>
        ) : error ? (
          <p role="alert" className="text-sm text-danger-strong">
            {error}
          </p>
        ) : answer ? (
          <div className="grid gap-4">
            {answer.narration.ok ? (
              <div className="grid gap-3 text-sm leading-relaxed">
                {answer.narration.text.split(/\n{2,}/).map((paragraph, i) => (
                  <p key={i}>{paragraph}</p>
                ))}
              </div>
            ) : (
              <p className="flex gap-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                {answer.narration.message}
              </p>
            )}
            <details className="rounded-lg border border-border bg-muted/40 px-4 py-3" open={!answer.narration.ok}>
              <summary className="cursor-pointer text-xs font-medium">The figures this answer uses</summary>
              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed tabular-nums">
                {answer.facts}
              </pre>
            </details>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Choose a question. BizMind answers only from figures it has already worked out from your
            marketplace reports, and shows you those figures with every answer.
          </p>
        )}
      </section>
    </div>
  )
}
