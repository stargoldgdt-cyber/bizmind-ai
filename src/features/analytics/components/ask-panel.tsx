"use client"

import { useState } from "react"
import { ArrowRight, Loader2 } from "lucide-react"

import { cn } from "cn"
import { LogoMark } from "@/components/brand/logo"
import { explainMetricAction, explainPeriodAction } from "@/features/analytics/actions"
import type { Narration } from "@/services/ai"

/**
 * Ask BizMind.
 *
 * WHY THE QUESTIONS ARE A LIST AND NOT A TEXT BOX
 * -----------------------------------------------
 * A free-text box would let someone ask "what will next quarter look like?" or
 * "should I fire my supplier?", and a language model will answer both —
 * fluently, and with numbers it made up. Every safeguard in this product exists
 * to stop exactly that.
 *
 * So each question here is bound to figures the analytics engine has already
 * computed. The model receives those figures and explains them; it is never
 * asked anything it has not been given the evidence for. What the owner loses
 * is the illusion of an oracle. What they gain is that every sentence on this
 * page is checkable.
 *
 * Free text is a real feature and a bigger problem than a UI: it needs the
 * question routed to the right verified facts before the model sees it. Until
 * that exists, this does not pretend to be it.
 *
 * NO FIGURES ARE SENT FROM THE BROWSER. Each action takes a period key and a
 * metric key, looks the rest up server-side, and hands verified values to the
 * model.
 */

type Question = {
  id: string
  ask: string
  /** A metric key from the analytics registry, or undefined for the period. */
  metric?: string
}

const QUESTIONS: Question[] = [
  { id: "period", ask: "What changed this period?" },
  { id: "profit", ask: "Why did my profit move?", metric: "net_profit" },
  { id: "margin", ask: "What is happening to my margin?", metric: "gross_margin" },
  { id: "revenue", ask: "How is revenue doing?", metric: "revenue" },
  { id: "fees", ask: "What are fees costing me?", metric: "fees" },
  { id: "expenses", ask: "Are my expenses under control?", metric: "expenses" },
]

export function AskPanel({ range, hasSales }: { range: string; hasSales: boolean }) {
  const [active, setActive] = useState<Question | null>(null)
  const [answer, setAnswer] = useState<Narration | "loading" | null>(null)

  async function ask(question: Question) {
    setActive(question)
    setAnswer("loading")

    try {
      const result = question.metric
        ? await explainMetricAction({ range, metric: question.metric })
        : await explainPeriodAction({ range })
      setAnswer(result)
    } catch {
      setAnswer({
        ok: false,
        reason: "failed",
        message:
          "That could not be answered just now. Your figures are unaffected.",
      })
    }
  }

  if (!hasSales) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-10 text-center">
        <p className="font-medium">Nothing to ask about yet</p>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          BizMind answers from your own figures, so there is nothing to explain
          until this period has some sales in it.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="lg:col-span-5">
        <ul className="space-y-2">
          {QUESTIONS.map((question) => (
            <li key={question.id}>
              <button
                type="button"
                onClick={() => ask(question)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors",
                  active?.id === question.id
                    ? "border-primary bg-accent font-medium text-accent-foreground"
                    : "border-border bg-card hover:bg-muted"
                )}
              >
                {question.ask}
                <ArrowRight className="size-4 shrink-0 opacity-50" aria-hidden />
              </button>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs text-muted-foreground">
          Every answer is built from figures already calculated from your
          records. BizMind explains them — it never produces one.
        </p>
      </div>

      <div className="lg:col-span-7">
        <div className="min-h-56 rounded-xl border border-border bg-card p-5 sm:p-6">
          {answer === null && (
            <p className="text-sm text-muted-foreground">
              Pick a question and BizMind will answer it from this period&apos;s
              figures.
            </p>
          )}

          {answer === "loading" && (
            <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Reading your figures…
            </p>
          )}

          {answer !== null && answer !== "loading" && (
            <div>
              <div className="flex items-center gap-2.5">
                <LogoMark className="size-5" />
                <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  {active?.ask}
                </p>
              </div>

              {answer.ok ? (
                <>
                  <p className="mt-3.5 text-pretty">{answer.text}</p>
                  <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                    Written by {answer.model} from figures BizMind calculated.
                  </p>
                </>
              ) : (
                // Not an error state in red. The figures are fine; only the
                // prose about them is missing, and saying so plainly avoids
                // implying the numbers are suspect.
                <p className="mt-3.5 text-sm text-muted-foreground">
                  {answer.message}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
