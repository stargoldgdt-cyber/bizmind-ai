import { ArrowRight, Info, MessageCircleMore, Paperclip, ShieldCheck, Sparkles, TrendingDown, TrendingUp } from "lucide-react"
import type { ComponentType, SVGProps } from "react"

import { LogoMark } from "@/components/brand/logo"
import { cn } from "cn"

import { analyst } from "../content"
import { SectionHeader } from "./section"

/**
 * Ask BizMind, rebuilt light to the owner's reference (2026-09-30).
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
 * margin stand unqualified when the cost data behind it is incomplete. Kept
 * as our real VAT-specific wording (LEDGER.md B1), not the reference's
 * generic placeholder note -- a fabricated caveat is still a fabrication.
 *
 * The input bar at the bottom is decorative, matching the real /ledger/ask
 * composer -- this card is a drawn mockup, not a live chat.
 */

const REASON_ICON: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  verified: MessageCircleMore,
  honest: ShieldCheck,
  plain: Sparkles,
}

export function Analyst() {
  const { exchange } = analyst

  return (
    <section
      id="analyst"
      className="relative overflow-hidden bg-surface-1 py-section-md text-surface-1-foreground"
      style={{ scrollMarginTop: "4rem" }}
    >
      {/* Soft blob field + dot grid, matching the other rebuilt sections. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 50% 45% at 6% 8%, oklch(0.7 0.09 293 / 0.28), transparent 65%)," +
            "radial-gradient(ellipse 50% 50% at 100% 100%, oklch(0.75 0.07 293 / 0.28), transparent 60%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "radial-gradient(color-mix(in oklch, var(--color-primary) 14%, transparent) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage:
            "radial-gradient(ellipse 22% 30% at 2% 4%, black, transparent 70%), radial-gradient(ellipse 22% 30% at 98% 96%, black, transparent 70%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 22% 30% at 2% 4%, black, transparent 70%), radial-gradient(ellipse 22% 30% at 98% 96%, black, transparent 70%)",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-marketing px-5 sm:px-8">
        <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-5">
            <SectionHeader
              level="2"
              size="lg"
              eyebrow={analyst.eyebrow}
              headline={
                <>
                  Don&apos;t just read the number.
                  <br />
                  <span className="text-primary">Ask why.</span>
                </>
              }
              support={analyst.support}
            />

            <ul className="mt-8 flex flex-col gap-5">
              {analyst.reasons.map((reason, index) => {
                const Icon = REASON_ICON[reason.key]
                return (
                  <li key={reason.key} data-reveal={index} className="flex min-w-0 items-start gap-3.5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="font-heading text-base font-bold tracking-tight">{reason.name}</p>
                      <p className="mt-0.5 text-sm text-pretty text-surface-2-muted">{reason.detail}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          <div data-reveal="1" className="lg:col-span-7">
            <div
              className="overflow-hidden rounded-3xl border border-surface-1-border bg-surface-1"
              style={{ boxShadow: "0 30px 70px -25px rgba(76,29,149,0.3)" }}
            >
              {/* Header */}
              <div className="flex items-center justify-between gap-3 border-b border-surface-1-border px-5 py-4 sm:px-6">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <LogoMark className="size-5" />
                  </span>
                  <p className="font-heading text-base font-bold tracking-tight">BizMind AI</p>
                </div>
                <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 font-mono text-xs font-semibold text-primary sm:flex">
                  <Sparkles className="size-3.5" aria-hidden />
                  {exchange.badge}
                </span>
              </div>

              {/* The question, in the owner's own words. */}
              <div className="flex items-start gap-3 border-b border-surface-1-border px-5 py-4 sm:px-6">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-[11px] font-bold text-primary-foreground">
                  Y
                </span>
                <p className="mt-0.5 font-heading text-base font-semibold tracking-tight text-pretty sm:text-lg">
                  {exchange.question}
                </p>
              </div>

              {/* The answer, with the working shown beneath it. */}
              <div className="px-5 py-5 sm:px-6 sm:py-6">
                <div className="flex items-start gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <TrendingUp className="size-4" aria-hidden />
                  </span>
                  <p className="mt-0.5 text-pretty">{exchange.answer}</p>
                </div>

                {/* Every figure in the answer, and nothing else. */}
                <dl className="mt-4 grid gap-2.5 sm:grid-cols-3">
                  {exchange.cited.map((figure) => (
                    <div key={figure.label} className="min-w-0 rounded-xl border border-surface-1-border p-3.5">
                      <dt className="truncate text-sm text-surface-1-muted">{figure.label}</dt>
                      <dd
                        className={cn(
                          "mt-1.5 flex items-center gap-1 font-mono text-lg font-bold tabular-nums",
                          figure.good ? "text-success" : "text-danger"
                        )}
                      >
                        {figure.direction === "up" ? (
                          <TrendingUp className="size-4" aria-hidden />
                        ) : (
                          <TrendingDown className="size-4" aria-hidden />
                        )}
                        {figure.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                <p className="mt-4 flex gap-2.5 rounded-xl bg-primary/5 p-3.5 text-sm text-surface-1-muted">
                  <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span>{exchange.caveat}</span>
                </p>
              </div>

              {/* Decorative composer, matching /ledger/ask's real input -- this card doesn't send anything. */}
              <div className="flex items-center gap-3 border-t border-surface-1-border px-5 py-3.5 sm:px-6">
                <Paperclip className="size-4 shrink-0 text-surface-1-muted" aria-hidden />
                <p className="min-w-0 flex-1 truncate text-sm text-surface-1-muted">{exchange.inputPlaceholder}</p>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <ArrowRight className="size-4" aria-hidden />
                </span>
              </div>
            </div>

            <p className="mt-4 text-sm text-surface-2-muted">
              Every figure above was calculated before the question was asked. BizMind explains them — it never
              produces one.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
