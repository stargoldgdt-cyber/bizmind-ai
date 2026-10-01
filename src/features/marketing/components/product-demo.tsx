import Image from "next/image"
import Link from "next/link"
import { ArrowRight, BarChart3, Maximize, Play, Settings, Sparkles, Volume2, Zap } from "lucide-react"
import type { ComponentType, SVGProps } from "react"

import { Button } from "@/components/ui/button"

import { productDemo } from "../content"
import { SectionHeader } from "./section"

/**
 * Product demo: the section that replaces Understand (retired 2026-09-30).
 *
 * NOT WIRED INTO THE PAGE YET
 * -----------------------------
 * This component is complete and ready, but src/app/page.tsx does not render
 * it -- see that file's header comment. `productDemo.videoUrl` (content.ts)
 * is empty until the owner records and uploads the real walkthrough; the
 * same "never ship a dead or inert control" rule that turned Preview into
 * two tabbed real panels instead of a video applies here. Once a real URL
 * exists, add `<ProductDemo />` to page.tsx -- nothing in this file changes.
 *
 * THE POSTER IS THE HERO'S OWN SCREENSHOT, NOT A SECOND DRAWN MOCKUP
 * -----------------------------------------------------------------
 * Owner correction, 2026-09-30: an earlier pass drew a second, smaller
 * dashboard mockup (sidebar, KPI cards, a bar chart) just for this frame's
 * poster. That was a second approximation of the same screen the hero
 * already shows faithfully -- public/hero/dashboard-preview.webp. Reusing
 * that real image here is both simpler and more honest: one real screenshot
 * standing in for the video, not two different drawings of it.
 */

const FEATURE_ICON: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  data: BarChart3,
  flow: Zap,
  gcc: Sparkles,
}

/** A small three-stroke spark mark, decorative only -- matches the owner's reference. */
function SparkMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <path d="M6 6 L13 13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M6 18 L11 16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M18 4 L15 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function VideoFrame() {
  return (
    <div className="relative mx-auto max-w-2xl lg:max-w-none">
      {/* Two offset card layers behind the frame, for the stacked-deck depth the reference uses. Negative insets so they're larger than the frame and actually peek out (a positive inset would sit entirely inside it, invisible). */}
      <div className="absolute -inset-4 -z-20 rotate-3 rounded-3xl bg-primary/20" aria-hidden />
      <div className="absolute -inset-2 -z-10 -rotate-2 rounded-3xl bg-primary/35" aria-hidden />

      <div
        className="relative overflow-hidden rounded-3xl border border-black/5 bg-surface-1"
        style={{ boxShadow: "0 30px 70px -25px rgba(76,29,149,0.4)" }}
      >
        <div className="relative">
          <Image
            src="/hero/dashboard-preview.webp"
            alt="BizMind dashboard: business performance for August 2026, with gross sales, net sales, marketplace costs and contribution, and an insight explaining why contribution changed"
            width={1639}
            height={959}
            className="h-auto w-full"
          />
          {/* Bottom scrim, so the player controls read on top of any part of the screenshot. */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/55 to-transparent"
            aria-hidden
          />
        </div>

        {/* Player chrome, overlaid on the screenshot -- decoration only; the whole frame is one Play control. */}
        <div className="absolute inset-x-0 bottom-0 px-4 py-3 sm:px-5">
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/25">
            <div className="h-full w-[6%] rounded-full bg-white" />
          </div>
          <div className="mt-2 flex items-center justify-between text-white">
            <span className="flex items-center gap-2 font-mono text-[11px]">
              <Play className="size-3 fill-current" aria-hidden />
              0:00 / 2:18
            </span>
            <span className="flex items-center gap-3">
              <Volume2 className="size-3.5" aria-hidden />
              <Settings className="size-3.5" aria-hidden />
              <Maximize className="size-3.5" aria-hidden />
            </span>
          </div>
        </div>
      </div>

      <Link
        href={productDemo.videoUrl || productDemo.secondaryCta.href}
        className="group absolute inset-0 flex items-center justify-center rounded-3xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        aria-label={productDemo.primaryCta.label}
      >
        <span
          className="flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground ring-[10px] ring-primary/20 transition-transform group-hover:scale-105 sm:size-20"
          style={{ boxShadow: "0 10px 40px -8px rgba(76,29,149,0.6)" }}
        >
          <Play className="size-6 fill-current sm:size-7" aria-hidden />
        </span>
      </Link>

      <SparkMark className="absolute -top-7 -right-6 hidden size-10 text-primary sm:block" />
    </div>
  )
}

export function ProductDemo() {
  return (
    <section
      id="product-demo"
      className="relative overflow-hidden bg-surface-2 py-section-md text-surface-2-foreground"
      style={{ scrollMarginTop: "4rem" }}
    >
      {/* Soft blob field, matching Hero, Loop and Preview's background treatment. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 55% 50% at 92% 10%, oklch(0.7 0.09 293 / 0.3), transparent 65%)," +
            "radial-gradient(ellipse 45% 45% at 4% 95%, oklch(0.75 0.07 293 / 0.28), transparent 60%)",
        }}
        aria-hidden
      />
      {/* Dot grid, one small cluster per far corner. */}
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
        <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-5">
            <SectionHeader
              level="2"
              eyebrow={productDemo.eyebrow}
              headline={
                <>
                  {productDemo.headline}
                  <span className="text-primary">{productDemo.headlineAccent}</span>
                </>
              }
              support={productDemo.support}
            />

            <ul className="mt-8 flex flex-col gap-5">
              {productDemo.features.map((feature) => {
                const Icon = FEATURE_ICON[feature.key]
                return (
                  <li key={feature.key} className="flex min-w-0 items-start gap-3.5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="font-heading text-base font-bold tracking-tight">{feature.name}</p>
                      <p className="mt-0.5 text-sm text-pretty text-surface-2-muted">{feature.detail}</p>
                    </div>
                  </li>
                )
              })}
            </ul>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button asChild size="lg" className="h-12 rounded-4xl px-6">
                <Link href={productDemo.videoUrl || productDemo.secondaryCta.href}>
                  <span className="flex size-6 items-center justify-center rounded-full bg-primary-foreground/20">
                    <Play className="size-2.5 fill-current" aria-hidden />
                  </span>
                  {productDemo.primaryCta.label}
                  <ArrowRight data-icon="inline-end" aria-hidden />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 rounded-4xl border-surface-2-border bg-surface-1 px-6 text-surface-2-foreground hover:bg-surface-1"
              >
                <Link href={productDemo.secondaryCta.href}>{productDemo.secondaryCta.label}</Link>
              </Button>
            </div>
          </div>

          <div className="lg:col-span-7">
            <VideoFrame />
          </div>
        </div>
      </div>
    </section>
  )
}
