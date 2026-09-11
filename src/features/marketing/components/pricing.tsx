import Link from "next/link"
import { Check } from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"

import { pricing } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * Pricing.
 *
 * THE FIGURES HERE ARE PLACEHOLDERS AND ARE MARKED AS SUCH ON THE PAGE.
 *
 * They are the only invented numbers on this site. Everything else is either
 * true today or explicitly labelled as not yet built, and a price quietly
 * invented by a developer is exactly the sort of thing that ships by accident
 * and then has to be honoured.
 *
 * So the notice renders while `placeholderNotice` is true in content.ts. Set
 * the real prices, flip that flag, and the notice disappears.
 *
 * Three plans, four to five lines each. A pricing table that needs studying
 * has already lost the reader — the job is to let them find themselves in one
 * row and press the button.
 */
export function Pricing() {
  return (
    <Band level="1" id="pricing">
      <SectionHeader
        level="1"
        eyebrow={pricing.eyebrow}
        headline={pricing.headline}
        support={pricing.support}
        align="center"
      />

      {pricing.placeholderNotice && (
        <p
          className="mx-auto mt-8 max-w-prose-comfortable rounded-xl border border-warning/35 bg-warning-subtle px-4 py-3 text-center text-sm text-warning-strong"
          role="note"
        >
          These prices are placeholders for layout review and are not final.
        </p>
      )}

      <div className="mt-12 grid items-start gap-4 lg:grid-cols-3">
        {pricing.plans.map((plan) => (
          <div
            key={plan.name}
            className={cn(
              "flex h-full flex-col rounded-2xl border p-6 sm:p-7",
              plan.featured
                ? "border-primary bg-surface-2"
                : "border-surface-1-border bg-surface-1"
            )}
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-heading text-lg font-semibold tracking-tight">
                {plan.name}
              </h3>
              {plan.featured && (
                <span className="rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground">
                  Most chosen
                </span>
              )}
            </div>

            <p className="mt-1 text-sm text-surface-1-muted">{plan.For}</p>

            <p className="mt-6 flex items-baseline gap-1.5">
              <span className="font-heading text-3xl font-bold tracking-tighter">
                {plan.price}
              </span>
              {plan.cadence && (
                <span className="text-sm text-surface-1-muted">{plan.cadence}</span>
              )}
            </p>

            <Button
              asChild
              size="lg"
              variant={plan.featured ? "default" : "outline"}
              className="mt-6 h-11 w-full rounded-4xl"
            >
              <Link href={plan.name === "Scale" ? "/signup" : "/signup"}>
                {plan.cta}
              </Link>
            </Button>

            <ul className="mt-7 space-y-3 text-sm">
              {plan.features.map((feature) => (
                <li key={feature} className="flex gap-2.5">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span className="text-pretty">{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Band>
  )
}
