import type { CSSProperties } from "react"
import Image from "next/image"
import Link from "next/link"
import { ArrowRight, Check, Play } from "lucide-react"

import { Button } from "@/components/ui/button"

import { hero } from "../content"

/**
 * The hero, built to the owner's supplied reference (2026-09-30).
 *
 * LIGHT, NOT DARK
 * ----------------
 * A deliberate reversal of the previous dark-band hero: a pale violet-tinted
 * surface (`surface-2`, the same token used elsewhere in the product -- no
 * new colour introduced) with a soft blob field and a faint dot-grid behind
 * the dashboard image. Matched to the reference exactly, at the owner's
 * explicit direction; not a restyle of the earlier dark version.
 *
 * THE DASHBOARD IS THE OWNER'S SUPPLIED IMAGE, NOT REBUILT UI
 * --------------------------------------------------------------
 * Owner correction, 2026-09-30: an earlier pass rebuilt the reference
 * dashboard as real markup (matching how every other product visual on this
 * page works) and it came out too large and too busy next to the reference's
 * own proportions. Rebuilding it wasn't the ask -- so this is now the
 * supplied image itself (public/hero/dashboard-preview.webp), sized down to
 * match the reference's balance, nothing drawn.
 *
 * REAL LOGO FILES, ON THEIR OWN FULL-WIDTH ROW
 * ------------------------------------------------
 * Amazon, noon and Carrefour's own logo files (public/logos/), supplied by
 * the owner -- not drawn or approximated. DESIGN.md §8's sanctioned
 * exception for a third-party integration logo grid.
 *
 * Owner correction, 2026-09-30: the strip used to live inside the narrower
 * text column, where four logo chips at a readable size didn't fit on one
 * line. It now spans the hero's full width below both columns, so the logos
 * can be sized generously and still sit on a single row -- and the text
 * column can be given more width for its own sake (the support sentence
 * wrapping to two lines instead of three) without the two problems trading
 * off against each other.
 */
/** The hero rises on load, in order: the position in the sequence, as a CSS variable the stylesheet reads. */
const step = (index: number) => ({ "--i": index }) as CSSProperties

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-surface-2 pt-14 pb-20 text-surface-2-foreground sm:pt-20 sm:pb-28">
      {/* Soft blob field, low-contrast, purely atmospheric. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 88% 8%, oklch(0.7 0.09 293 / 0.35), transparent 65%)," +
            "radial-gradient(ellipse 50% 55% at 0% 100%, oklch(0.75 0.07 293 / 0.3), transparent 60%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage: "radial-gradient(color-mix(in oklch, var(--color-primary) 14%, transparent) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage: "radial-gradient(ellipse 65% 55% at 82% 15%, black, transparent 72%)",
          WebkitMaskImage: "radial-gradient(ellipse 65% 55% at 82% 15%, black, transparent 72%)",
        }}
        aria-hidden
      />

      {/* Wider than the rest of the page's max-w-marketing: this hero has a big supplied image and a
          full-width logo row to fit, and a marketing hero is where extra width is spent on exactly that. */}
      <div className="relative mx-auto max-w-[90rem] px-5 sm:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-5">
            <span
              className="hero-in inline-flex rounded-full bg-primary/10 px-3.5 py-1.5 font-mono text-xs font-bold tracking-widest text-primary"
              style={step(0)}
            >
              {hero.eyebrow}
            </span>

            <h1 style={step(1)} className="hero-in mt-5 font-heading text-4xl leading-[1.05] font-extrabold tracking-tighter text-balance sm:text-[3.2rem]">
              {hero.headline}
              <br />
              <span className="text-primary">{hero.headlineAccent}</span>
            </h1>

            <p style={step(2)} className="hero-in mt-6 max-w-prose-comfortable text-base text-pretty text-surface-2-muted">
              {hero.support}
            </p>

            <div style={step(3)} className="hero-in mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
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
                className="h-12 rounded-4xl border-surface-2-border bg-surface-1 px-6 text-surface-2-foreground hover:bg-surface-1"
              >
                <a href={hero.secondary.href}>
                  <span className="flex size-6 items-center justify-center rounded-full bg-surface-2-foreground text-surface-1">
                    <Play className="size-2.5 fill-current" aria-hidden />
                  </span>
                  {hero.secondary.label}
                </a>
              </Button>
            </div>

            <ul style={step(4)} className="hero-in mt-6 flex flex-col gap-2.5 text-sm text-surface-2-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2">
              {hero.trust.map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="size-2.5" aria-hidden />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="lg:col-span-7">
            <div style={step(2)} className="hero-in mx-auto max-w-2xl overflow-hidden rounded-2xl border border-black/5 shadow-[0_30px_70px_-25px_rgba(76,29,149,0.35)] lg:max-w-none">
              <Image
                src="/hero/dashboard-preview.webp"
                alt="BizMind dashboard: business performance for August 2026, with gross sales, net sales, marketplace costs and contribution, and an insight explaining why contribution changed"
                width={1639}
                height={959}
                className="h-auto w-full"
                priority
              />
            </div>
          </div>
        </div>

        {/* Real logo files, on their own full-width row so they never have to compete with the text column for space. */}
        <div data-reveal="0" className="mt-10 flex flex-wrap items-center gap-3 lg:mt-14">
          <span className="font-mono text-[11px] font-bold tracking-widest text-surface-2-muted uppercase">
            Connects to
          </span>
          {hero.marketplaces.map((m) => (
            <span
              key={m.name}
              className="inline-flex h-14 items-center rounded-xl border border-surface-2-border bg-surface-1 px-5"
            >
              <Image src={m.logo} alt={m.name} width={96} height={28} className="h-7 w-auto object-contain" unoptimized />
            </span>
          ))}
          <span className="inline-flex h-14 items-center rounded-xl border border-dashed border-surface-2-border px-5 font-mono text-sm text-surface-2-muted">
            + More
          </span>
        </div>
      </div>
    </section>
  )
}
