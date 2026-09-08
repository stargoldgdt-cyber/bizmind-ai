import { ArrowRight, Check, Sparkles } from "lucide-react"

import { Logo, LogoMark } from "@/components/brand/logo"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { siteConfig } from "@/config/site"

/**
 * Foundation page.
 *
 * This is NOT the product dashboard. It exists to prove that the Phase 1
 * foundation is wired correctly: Next.js renders, Tailwind compiles, the
 * shadcn components mount, the design tokens resolve, and the three fonts
 * load. It will be replaced when the real application shell is built.
 */

/** The checks this page is verifying, rendered as a status list. */
const foundationChecks = [
  "Next.js 16 App Router with TypeScript",
  "Tailwind CSS v4 compiling from design tokens",
  "shadcn/ui components on Radix primitives",
  "Light and dark themes from one token set",
  "Three-font system loaded through next/font",
] as const

/** Swatches rendered from CSS variables — never from hard-coded hex. */
const brandSwatches = [
  { label: "Brand 400", className: "bg-brand-400" },
  { label: "Brand 500", className: "bg-brand-500" },
  { label: "Brand 600", className: "bg-brand-600" },
  { label: "Brand 700", className: "bg-brand-700" },
  { label: "Navy 800", className: "bg-navy-800" },
  { label: "Navy 950", className: "bg-navy-950" },
] as const

const statusSwatches = [
  { label: "Success", className: "bg-success" },
  { label: "Warning", className: "bg-warning" },
  { label: "Danger", className: "bg-danger" },
  { label: "Info", className: "bg-info" },
] as const

const chartSwatches = [
  { label: "Series 1", className: "bg-chart-1" },
  { label: "Series 2", className: "bg-chart-2" },
  { label: "Series 3", className: "bg-chart-3" },
  { label: "Series 4", className: "bg-chart-4" },
  { label: "Series 5", className: "bg-chart-5" },
  { label: "Series 6", className: "bg-chart-6" },
] as const

export default function FoundationPage() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Logo />
          <Badge variant="secondary" className="hidden sm:inline-flex">
            Phase 1 — Foundation
          </Badge>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 pb-24 sm:px-8">
        {/* ---- Hero ---------------------------------------------------- */}
        <section className="py-16 sm:py-24">
          <div className="inline-flex items-center gap-2 rounded-4xl border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-xs">
            <Sparkles className="size-3.5 text-primary" aria-hidden />
            AI business intelligence and automation
          </div>

          <h1 className="mt-6 max-w-3xl text-4xl font-extrabold text-balance sm:text-5xl lg:text-6xl">
            Connect your business.{" "}
            <span className="text-brand-gradient">Know what to do next.</span>
          </h1>

          <p className="mt-6 max-w-2xl text-lg text-pretty text-muted-foreground sm:text-xl">
            {siteConfig.tagline}
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button size="lg" className="h-11 rounded-4xl px-6 text-sm shadow-glow">
              Get started
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Button>
            <Button size="lg" variant="outline" className="h-11 rounded-4xl px-6 text-sm">
              See how it works
            </Button>
          </div>

          {/* The product loop. */}
          <div className="mt-14 flex flex-wrap items-center gap-x-2 gap-y-3">
            {siteConfig.pillars.map((pillar, index) => (
              <div key={pillar} className="flex items-center gap-2">
                <span className="rounded-4xl bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground">
                  {pillar}
                </span>
                {index < siteConfig.pillars.length - 1 && (
                  <ArrowRight className="size-3 text-muted-foreground/60" aria-hidden />
                )}
              </div>
            ))}
          </div>
        </section>

        <Separator />

        {/* ---- Design system preview ----------------------------------- */}
        <section className="py-16">
          <p className="text-xs font-semibold tracking-widest text-primary uppercase">
            Design system
          </p>
          <h2 className="mt-3 text-2xl font-bold sm:text-3xl">
            One token set, every surface
          </h2>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Every colour below is read from a CSS variable defined in one file.
            Changing the brand means editing that file — not hunting through
            components.
          </p>

          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Brand and surfaces</CardTitle>
                <CardDescription>
                  Violet carries the brand. Navy carries contrast sections.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                  {brandSwatches.map((swatch) => (
                    <div key={swatch.label} className="space-y-2">
                      <div
                        className={`h-14 rounded-lg ring-1 ring-foreground/10 ${swatch.className}`}
                      />
                      <p className="text-[11px] text-muted-foreground">{swatch.label}</p>
                    </div>
                  ))}
                </div>

                <div>
                  <p className="mb-3 text-xs font-medium text-muted-foreground">
                    Status — reserved meanings, never used for chart series
                  </p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {statusSwatches.map((swatch) => (
                      <div key={swatch.label} className="space-y-2">
                        <div
                          className={`h-10 rounded-lg ring-1 ring-foreground/10 ${swatch.className}`}
                        />
                        <p className="text-[11px] text-muted-foreground">{swatch.label}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-3 text-xs font-medium text-muted-foreground">
                    Chart series — validated for colour-blind separation in both themes
                  </p>
                  <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                    {chartSwatches.map((swatch) => (
                      <div key={swatch.label} className="space-y-2">
                        <div
                          className={`h-10 rounded-lg ring-1 ring-foreground/10 ${swatch.className}`}
                        />
                        <p className="text-[11px] text-muted-foreground">{swatch.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Typography</CardTitle>
                <CardDescription>Three faces, each with a job.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <p className="text-[11px] text-muted-foreground">
                    Heading — Plus Jakarta Sans
                  </p>
                  <p className="font-heading text-2xl font-bold tracking-tight">
                    Profit is down 3.1%
                  </p>
                </div>
                <Separator />
                <div>
                  <p className="text-[11px] text-muted-foreground">Body — Inter</p>
                  <p className="text-sm">
                    Your website earns a stronger margin than Amazon despite
                    lower revenue.
                  </p>
                </div>
                <Separator />
                <div>
                  <p className="text-[11px] text-muted-foreground">
                    Figures — JetBrains Mono, tabular
                  </p>
                  <div className="mt-1 space-y-0.5 font-mono text-sm tabular-nums">
                    <p>1,240,500.00</p>
                    <p>&nbsp;&nbsp;982,110.50</p>
                    <p>&nbsp;&nbsp;&nbsp;62,000.75</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Buttons and badges. */}
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Buttons</CardTitle>
                <CardDescription>Pill CTAs for primary actions.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <Button className="rounded-4xl">Primary</Button>
                <Button variant="secondary" className="rounded-4xl">
                  Secondary
                </Button>
                <Button variant="outline" className="rounded-4xl">
                  Outline
                </Button>
                <Button variant="ghost" className="rounded-4xl">
                  Ghost
                </Button>
                <Button variant="destructive" className="rounded-4xl">
                  Destructive
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Badges</CardTitle>
                <CardDescription>Compact labels and states.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                <Badge>Default</Badge>
                <Badge variant="secondary">Secondary</Badge>
                <Badge variant="outline">Outline</Badge>
                <Badge variant="destructive">Anomaly</Badge>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ---- Dark contrast section ----------------------------------- */}
        <section className="rounded-2xl bg-navy-950 p-8 text-white sm:p-12">
          <LogoMark className="size-9 text-brand-400" />
          <h2 className="mt-6 max-w-xl text-2xl font-bold text-balance sm:text-3xl">
            Foundation verified
          </h2>
          <p className="mt-3 max-w-xl text-white/70">
            Everything below is running. No business features are built yet —
            that is intentional. This is the base the rest of BizMind is built
            on.
          </p>

          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {foundationChecks.map((check) => (
              <li key={check} className="flex items-start gap-2.5 text-sm text-white/85">
                <Check className="mt-0.5 size-4 shrink-0 text-brand-400" aria-hidden />
                {check}
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>{siteConfig.name} — internal foundation build</p>
          <p>Phase 1 of 15</p>
        </div>
      </footer>
    </div>
  )
}
