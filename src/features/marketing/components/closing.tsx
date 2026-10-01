import Link from "next/link"
import { ArrowRight, CreditCard, FileText, Play, ShieldCheck } from "lucide-react"
import type { ComponentType, SVGProps } from "react"

import { Button } from "@/components/ui/button"

import { Logo } from "@/components/brand/logo"
import { siteConfig } from "@/config/site"

import { closing, footer } from "../content"
import { SectionHeader } from "./section"

/**
 * The close, and the footer under it.
 *
 * SHORT AND CENTRED, NOT A SECOND HERO
 * --------------------------------------
 * An earlier pass echoed the hero exactly -- same dashboard screenshot,
 * split layout, logo tiles -- and the owner asked for something visibly
 * different and shorter (2026-09-30). By the time a reader reaches the
 * close they've already seen the product; this is the ask, not another
 * demonstration, so it's a compact centred band -- eyebrow, headline,
 * support, two buttons, three trust lines -- with no image at all.
 *
 * WHY THE VIOLET BAND IS GONE
 * ----------------------------
 * DESIGN.md originally reserved a full violet band for exactly this
 * section. Every other section on this page has since moved to the same
 * light lavender-blob treatment, so a solid violet close would now read as
 * the odd one out rather than a deliberate climax -- kept the same light
 * surface, violet spent on the button and the accent word only.
 *
 * NO SOCIAL LINKS
 * ----------------
 * BizMind has no real social accounts anywhere in this codebase to point a
 * footer icon at, and a link to nowhere real reads as unfinished. Left them
 * out rather than invent a URL.
 */

const TRUST_ICON: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  card: CreditCard,
  contract: FileText,
  secure: ShieldCheck,
}

export function Closing() {
  return (
    <>
      <section className="relative overflow-hidden bg-surface-2 py-section-md text-surface-2-foreground">
        {/* A single soft blob, centred -- quieter than a full corner-to-corner field, matching this band's shorter, calmer close. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: "radial-gradient(ellipse 50% 70% at 50% 0%, oklch(0.7 0.09 293 / 0.25), transparent 65%)",
          }}
          aria-hidden
        />

        <div className="relative mx-auto max-w-2xl px-5 text-center sm:px-8">
          <SectionHeader
            level="2"
            align="center"
            eyebrow={closing.eyebrow}
            headline={
              <>
                {closing.headline} <span className="text-primary">{closing.headlineAccent}</span>
              </>
            }
            support={closing.support}
          />

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="h-12 rounded-4xl px-6">
              <Link href={closing.primary.href}>
                {closing.primary.label}
                <ArrowRight data-icon="inline-end" aria-hidden />
              </Link>
            </Button>

            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 rounded-4xl border-surface-2-border bg-surface-1 px-6 text-surface-2-foreground hover:bg-surface-1"
            >
              <a href={closing.secondary.href}>
                <span className="flex size-6 items-center justify-center rounded-full bg-surface-2-foreground text-surface-1">
                  <Play className="size-2.5 fill-current" aria-hidden />
                </span>
                {closing.secondary.label}
              </a>
            </Button>
          </div>

          <ul className="mt-9 flex flex-col items-center justify-center gap-3 text-sm sm:flex-row sm:flex-wrap sm:gap-x-7 sm:gap-y-2">
            {closing.trust.map((item) => {
              const Icon = TRUST_ICON[item.key]
              return (
                <li key={item.key} className="flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Icon className="size-3.5" aria-hidden />
                  </span>
                  <span className="font-semibold">{item.label}</span>
                  <span className="text-surface-2-muted">— {item.detail}</span>
                </li>
              )
            })}
          </ul>
        </div>
      </section>

      <footer className="bg-surface-3 py-14 text-surface-3-foreground">
        <div className="mx-auto max-w-marketing px-5 sm:px-8">
          <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
            <div className="max-w-xs">
              <Logo />
              <p className="mt-4 text-sm text-surface-3-muted">{footer.note}</p>
            </div>

            <div className="flex gap-10 sm:gap-14">
              {footer.groups.map((group, index) => (
                <div
                  key={group.title}
                  className={index > 0 ? "border-l border-surface-3-border pl-10 sm:pl-14" : undefined}
                >
                  <p className="font-mono text-[11px] tracking-wider text-surface-3-muted uppercase">
                    {group.title}
                  </p>
                  <ul className="mt-4 space-y-2.5">
                    {group.links.map((link) => (
                      <li key={link.label}>
                        <a
                          href={link.href}
                          className="text-sm text-surface-3-muted transition-colors hover:text-surface-3-foreground"
                        >
                          {link.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-12 flex flex-col gap-3 border-t border-surface-3-border pt-6 text-xs text-surface-3-muted sm:flex-row sm:items-center sm:justify-between">
            <p>
              © {new Date().getFullYear()} {siteConfig.name}. All rights reserved.
            </p>
            <p>Built for marketplace sellers, not accountants.</p>
          </div>
        </div>
      </footer>
    </>
  )
}
