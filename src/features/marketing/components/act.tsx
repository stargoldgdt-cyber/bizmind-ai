import { BellRing } from "lucide-react"

import { act } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * Alerts and automation.
 *
 * THE HONEST VERSION OF THIS SECTION
 * ----------------------------------
 * The tempting copy here is "BizMind watches your business and acts on it".
 * BizMind does not act. It raises an alert, and a person decides. Saying
 * otherwise would be the one lie on this page that a buyer could not check
 * until after they had bought.
 *
 * So the headline says what it does and what it will not do, in that order.
 *
 * WHAT IS ACTUALLY BEING SOLD HERE
 * --------------------------------
 * Not the ability to send an alert — anything can send an alert. It is the
 * three refusals underneath: a quiet period is not a crisis, an untrustworthy
 * figure does not raise an alarm, and silence can be explained. Those are what
 * separate an alert somebody still reads in month six from one they muted in
 * week two.
 */
export function Act() {
  return (
    <Band level="1" id="act">
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <SectionHeader
            level="1"
            eyebrow={act.eyebrow}
            headline={act.headline}
            support={act.support}
          />
        </div>

        {/* The rule, in the shape the product actually stores it. */}
        <div className="lg:col-span-7">
          <div className="overflow-hidden rounded-2xl border border-surface-1-border">
            <div className="flex items-center gap-2.5 border-b border-surface-1-border bg-surface-2 px-5 py-3.5">
              <BellRing className="size-4 text-primary" aria-hidden />
              <p className="font-mono text-[11px] tracking-wider text-surface-1-muted uppercase">
                Your rule
              </p>
            </div>

            <div className="divide-y divide-surface-1-border">
              <Clause keyword="When">
                <Token>{act.rule.when}</Token>
                <span className="text-surface-1-muted">{act.rule.operator}</span>
                <Token>{act.rule.threshold}</Token>
                <span className="text-surface-1-muted">{act.rule.period}</span>
              </Clause>

              <Clause keyword="Then">
                <Token>{act.rule.then}</Token>
              </Clause>

              <Clause keyword="But">
                <span className="text-surface-1-muted">{act.rule.cooldown}</span>
              </Clause>
            </div>
          </div>

          <p className="mt-4 text-sm text-surface-1-muted">
            Nothing in BizMind buys, prices, emails a customer, or changes your
            store. You are told; you decide.
          </p>
        </div>
      </div>

      {/* The three refusals. Hairlines, not cards — they are one argument. */}
      <div className="mt-16 grid gap-px overflow-hidden rounded-2xl border border-surface-1-border bg-surface-1-border sm:grid-cols-3">
        {act.restraint.map((item) => (
          <div key={item.title} className="bg-surface-1 p-6">
            <h3 className="font-heading text-base font-semibold tracking-tight text-balance">
              {item.title}
            </h3>
            <p className="mt-2 text-sm text-pretty text-surface-1-muted">{item.body}</p>
          </div>
        ))}
      </div>
    </Band>
  )
}

/** One line of the rule. The keyword is fixed-width so the clauses align. */
function Clause({
  keyword,
  children,
}: {
  keyword: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-5 py-4">
      <span className="w-11 shrink-0 font-mono text-[11px] tracking-wider text-primary uppercase">
        {keyword}
      </span>
      {children}
    </div>
  )
}

/** A value the owner chose, distinguished from the words around it. */
function Token({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-surface-1-border bg-surface-2 px-2.5 py-1 font-mono text-sm">
      {children}
    </span>
  )
}
