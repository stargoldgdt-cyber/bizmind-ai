"use client"

import { useState } from "react"
import Link from "next/link"
import { Check } from "lucide-react"

import { cn } from "cn"
import { Button } from "@/components/ui/button"

import { pricing } from "../content"
import { Band, SectionHeader } from "./section"

/**
 * Pricing, rebuilt to the owner's reference (2026-09-30) with real prices.
 *
 * Three plans, five to seven lines each. A pricing table that needs
 * studying has already lost the reader -- the job is to let them find
 * themselves in one row and press the button.
 *
 * The monthly/yearly toggle only changes which pre-set figure is shown
 * (`plan.price.monthly` / `.yearly`, both authored in content.ts) -- nothing
 * is computed here, so there's no arithmetic to get wrong on a pricing page.
 */
export function Pricing() {
  const [yearly, setYearly] = useState(false)

  return (
    <Band level="1" id="pricing">
      <SectionHeader
        level="1"
        eyebrow={pricing.eyebrow}
        headline={
          <>
            {pricing.headline}
            <span className="text-primary">{pricing.headlineAccent}</span>
          </>
        }
        support={pricing.support}
        align="center"
      />

      <div className="mx-auto mt-8 flex w-fit items-center gap-1 rounded-full border border-surface-1-border bg-surface-1 p-1">
        <button
          type="button"
          onClick={() => setYearly(false)}
          aria-pressed={!yearly}
          className={cn(
            "rounded-full px-4 py-2 text-sm font-semibold transition-colors",
            !yearly ? "bg-primary text-primary-foreground" : "text-surface-1-muted hover:text-surface-1-foreground"
          )}
        >
          {pricing.billing.monthly}
        </button>
        <button
          type="button"
          onClick={() => setYearly(true)}
          aria-pressed={yearly}
          className={cn(
            "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
            yearly ? "bg-primary text-primary-foreground" : "text-surface-1-muted hover:text-surface-1-foreground"
          )}
        >
          {pricing.billing.yearly}
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide uppercase",
              yearly ? "bg-primary-foreground/20" : "bg-primary/10 text-primary"
            )}
          >
            {pricing.billing.yearlyBadge}
          </span>
        </button>
      </div>

      <div className="mt-10 grid items-start gap-4 lg:grid-cols-3">
        {pricing.plans.map((plan) => {
          const price = yearly ? plan.price.yearly : plan.price.monthly
          const isCustom = price === "Custom pricing"

          return (
            <div
              key={plan.key}
              className={cn(
                "flex h-full flex-col rounded-2xl border p-6 sm:p-7",
                plan.featured ? "border-primary bg-primary/[0.04]" : "border-surface-1-border bg-surface-1"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-heading text-xl font-bold tracking-tight">{plan.name}</h3>
                {"badge" in plan && plan.badge && (
                  <span className="shrink-0 rounded-full bg-primary px-2.5 py-1 font-mono text-[10px] font-bold tracking-wide text-primary-foreground uppercase">
                    {plan.badge}
                  </span>
                )}
              </div>

              <p className="mt-1 text-sm text-surface-1-muted">{plan.description}</p>

              <div className="mt-5 border-t border-surface-1-border pt-5">
                <p className="flex items-baseline gap-1.5">
                  {isCustom ? (
                    <span className="font-heading text-3xl font-extrabold tracking-tighter">{price}</span>
                  ) : (
                    <>
                      <span className="font-heading text-4xl font-extrabold tracking-tighter tabular-nums">
                        AED {price}
                      </span>
                      {plan.cadence && <span className="text-sm text-surface-1-muted">/ {plan.cadence}</span>}
                    </>
                  )}
                </p>
              </div>

              <Button
                asChild
                size="lg"
                variant={plan.featured ? "default" : "outline"}
                className="mt-6 h-11 w-full rounded-4xl"
              >
                <Link href={plan.cta.href}>{plan.cta.label}</Link>
              </Button>

              <ul className="mt-7 space-y-4 text-sm">
                {plan.features.map((feature) => (
                  <li key={feature.text} className="flex gap-2.5">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-pretty">{feature.text}</span>
                      {"note" in feature && feature.note && (
                        <span className="mt-0.5 block text-pretty text-surface-1-muted">{feature.note}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </Band>
  )
}
