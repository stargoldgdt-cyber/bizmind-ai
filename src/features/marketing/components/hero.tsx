import Link from "next/link"
import { ArrowRight, Play } from "lucide-react"

import { Button } from "@/components/ui/button"

import { hero } from "../content"
import { ProfitConsole } from "./profit-console"

/**
 * The hero.
 *
 * ASYMMETRIC ON PURPOSE
 * ---------------------
 * Five columns of words, seven of product. A centred headline over empty space
 * is the default shape of every AI landing page written in the last two years,
 * and it makes the reader take the claim on faith. Giving the product the
 * larger half means the first thing they judge is the thing they would buy.
 *
 * NO GRADIENT, NO GLOW
 * --------------------
 * The band is one flat near-black field. Depth comes from the console sitting
 * on it as a raised surface with a hairline border — the same way depth works
 * everywhere else in this product (DESIGN.md §11: there is no glow token).
 */
export function Hero() {
  return (
    <section className="bg-surface-3 pt-14 pb-16 text-surface-3-foreground sm:pt-20 sm:pb-24">
      <div className="mx-auto max-w-marketing px-5 sm:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-14">
          <div className="lg:col-span-5">
            <p className="font-mono text-xs font-medium tracking-widest text-brand-300 uppercase">
              {hero.eyebrow}
            </p>

            <h1 className="mt-5 font-heading text-4xl font-bold tracking-tighter text-balance sm:text-5xl">
              {hero.headline}
              <br />
              <span className="text-brand-300">{hero.headlineAccent}</span>
            </h1>

            <p className="mt-6 max-w-prose-comfortable text-lg text-pretty text-surface-3-muted">
              {hero.support}
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button asChild size="lg" className="h-12 rounded-4xl px-6">
                <Link href={hero.primary.href}>
                  {hero.primary.label}
                  <ArrowRight data-icon="inline-end" aria-hidden />
                </Link>
              </Button>

              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 rounded-4xl border-surface-3-border bg-transparent px-6 text-surface-3-foreground hover:bg-surface-3-raised hover:text-surface-3-foreground"
              >
                <a href={hero.secondary.href}>
                  <Play className="size-4 fill-current" aria-hidden />
                  {hero.secondary.label}
                </a>
              </Button>
            </div>

            <p className="mt-5 text-sm text-surface-3-muted">{hero.note}</p>
          </div>

          <div className="lg:col-span-7">
            <ProfitConsole />
          </div>
        </div>
      </div>
    </section>
  )
}
