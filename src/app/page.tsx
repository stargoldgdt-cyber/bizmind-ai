import type { Metadata } from "next"

import { siteConfig } from "@/config/site"
import { Analyst } from "@/features/marketing/components/analyst"
import { Closing } from "@/features/marketing/components/closing"
import { Connect } from "@/features/marketing/components/connect"
import { Hero } from "@/features/marketing/components/hero"
import { Loop } from "@/features/marketing/components/loop"
import { MarketingNav } from "@/features/marketing/components/nav"
import { Preview } from "@/features/marketing/components/preview"
import { Pricing } from "@/features/marketing/components/pricing"
import { Problem } from "@/features/marketing/components/problem"
import { ProductDemo } from "@/features/marketing/components/product-demo"
import { ScrollReveal } from "@/features/marketing/components/scroll-reveal"

/**
 * The BizMind landing page.
 *
 * THE ORDER IS AN ARGUMENT, NOT A MENU
 * ------------------------------------
 * Each band answers one question, and each one is only asked because the band
 * before it earned the right to:
 *
 *   Hero         what is this, and what does it look like
 *   Problem      why your current dashboard is not enough
 *   Loop         where BizMind goes further than a report
 *   Preview      show me, then -- two real panels, tabbed, nothing "coming soon"
 *   Product demo see it in motion (owner override, 2026-09-30: live with no
 *                real recording yet -- Play links to Loop instead; see
 *                product-demo.tsx's header comment)
 *   Analyst      can it tell me WHY
 *   Connect      will it work with what I already run
 *   Pricing      what does it cost
 *   Closing      fine — what now
 *
 * NO TWO ADJACENT BANDS SHARE A COMPOSITION
 * -----------------------------------------
 * Split hero, centred ledger, horizontal rail, full-bleed frame, bento,
 * offset conversation, split rule builder, centred grid, numbered columns,
 * three plans, centred close. The repeated text-left/image-right rhythm is
 * the single clearest tell of a generated page, so it appears nowhere.
 *
 * MOSTLY ONE LIGHT SURFACE NOW, NOT AN ALTERNATION
 * ---------------------------------------------------
 * DESIGN.md's original band rhythm (surfaces alternating 3 → 1 → 2 → 3 → …,
 * violet spent once at the close) no longer describes this page: every
 * section from Problem through Closing was rebuilt light (bg-surface-2,
 * the same blob-and-dot-grid treatment) against owner-supplied references
 * over the course of 2026-09-30, and Closing itself dropped the violet
 * band. Only Analyst... no, nothing dark remains except the footer
 * (surface-3). DESIGN.md hasn't been updated to match; treat the code as
 * the current truth until it is.
 *
 * EVERY SECTION IS A SERVER COMPONENT except the nav, the preview and
 * pricing, which need state for the mobile menu, the tab switch and the
 * monthly/yearly toggle.
 *
 * SCROLL MOTION (owner request, 2026-10-06): sections mark what reveals with a
 * `data-reveal` attribute and <ScrollReveal /> does the rest, so the sections
 * stay server components. See scroll-reveal.tsx and DESIGN.md section 11.
 */

const TITLE = `${siteConfig.name} — Marketplace profit for Amazon and noon sellers`

export const metadata: Metadata = {
  title: TITLE,
  description: siteConfig.description,
  openGraph: {
    title: TITLE,
    description: siteConfig.description,
    type: "website",
    siteName: siteConfig.name,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: siteConfig.description,
  },
}

export default function LandingPage() {
  return (
    <div className="min-h-dvh bg-surface-1 text-surface-1-foreground">
      {/* Keyboard users should not have to tab the whole nav on every visit. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <MarketingNav />
      <ScrollReveal />

      <main id="main">
        <Hero />
        <Problem />
        <Loop />
        <Preview />
        <ProductDemo />
        <Analyst />
        <Connect />
        <Pricing />
      </main>

      <Closing />
    </div>
  )
}
