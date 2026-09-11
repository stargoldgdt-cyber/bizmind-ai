import type { Metadata } from "next"

import { siteConfig } from "@/config/site"
import { Act } from "@/features/marketing/components/act"
import { Analyst } from "@/features/marketing/components/analyst"
import { Closing } from "@/features/marketing/components/closing"
import { Connect } from "@/features/marketing/components/connect"
import { Film } from "@/features/marketing/components/film"
import { Hero } from "@/features/marketing/components/hero"
import { Loop } from "@/features/marketing/components/loop"
import { MarketingNav } from "@/features/marketing/components/nav"
import { Pricing } from "@/features/marketing/components/pricing"
import { Problem } from "@/features/marketing/components/problem"
import { Trust } from "@/features/marketing/components/trust"
import { Understand } from "@/features/marketing/components/understand"

/**
 * The BizMind landing page.
 *
 * THE ORDER IS AN ARGUMENT, NOT A MENU
 * ------------------------------------
 * Each band answers one question, and each one is only asked because the band
 * before it earned the right to:
 *
 *   Hero       what is this, and what does it look like
 *   Problem    why your current dashboard is not enough
 *   Loop       where BizMind goes further than a report
 *   Film       show me, then
 *   Understand can I believe the numbers
 *   Analyst    can it tell me WHY
 *   Act        will it warn me, and will it act without asking
 *   Connect    will it work with what I already run
 *   Trust      why should I believe any of this
 *   Pricing    what does it cost
 *   Closing    fine — what now
 *
 * NO TWO ADJACENT BANDS SHARE A COMPOSITION
 * -----------------------------------------
 * Split hero, centred ledger, horizontal rail, full-bleed frame, bento,
 * offset conversation, split rule builder, centred grid, numbered columns,
 * three plans, centred close. The repeated text-left/image-right rhythm is
 * the single clearest tell of a generated page, so it appears nowhere.
 *
 * Surface levels alternate 3 → 1 → 2 → 3 → 1 → 3 → 1 → 1 → 3 → 1 → brand.
 * The violet band is spent once, at the close.
 *
 * EVERY SECTION IS A SERVER COMPONENT except the nav and the film, which need
 * state for the mobile menu and the play control.
 */

export const metadata: Metadata = {
  title: `${siteConfig.name} — Know your numbers. Know what to do next.`,
  description: siteConfig.description,
  openGraph: {
    title: `${siteConfig.name} — Know your numbers. Know what to do next.`,
    description: siteConfig.description,
    type: "website",
    siteName: siteConfig.name,
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteConfig.name} — Know your numbers. Know what to do next.`,
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

      <main id="main">
        <Hero />
        <Problem />
        <Loop />
        <Film />
        <Understand />
        <Analyst />
        <Act />
        <Connect />
        <Trust />
        <Pricing />
      </main>

      <Closing />
    </div>
  )
}
