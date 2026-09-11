import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"

import { Logo } from "@/components/brand/logo"
import { siteConfig } from "@/config/site"

import { closing, footer } from "../content"

/**
 * The close, and the footer under it.
 *
 * The violet band appears exactly once on this page, here. DESIGN.md reserves
 * it for the promise and the close; using it earlier would have spent the only
 * moment where a full field of brand colour still means something.
 *
 * One primary action, one secondary, and nothing else competing.
 */
export function Closing() {
  return (
    <>
      <section className="bg-surface-brand py-section-lg text-surface-brand-foreground">
        <div className="mx-auto max-w-marketing px-5 text-center sm:px-8">
          <h2 className="font-heading text-4xl font-bold tracking-tighter text-balance sm:text-5xl">
            {closing.headline}{" "}
            <span className="text-surface-brand-muted">{closing.headlineAccent}</span>
          </h2>

          <p className="mx-auto mt-6 max-w-prose-comfortable text-lg text-pretty text-surface-brand-muted">
            {closing.support}
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="h-12 rounded-4xl bg-surface-1 px-7 text-surface-1-foreground hover:bg-surface-2"
            >
              <Link href={closing.primary.href}>
                {closing.primary.label}
                <ArrowRight data-icon="inline-end" aria-hidden />
              </Link>
            </Button>

            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 rounded-4xl border-surface-brand-border bg-transparent px-7 text-surface-brand-foreground hover:bg-surface-brand-raised hover:text-surface-brand-foreground"
            >
              <a href={closing.secondary.href}>{closing.secondary.label}</a>
            </Button>
          </div>
        </div>
      </section>

      <footer className="bg-surface-3 py-14 text-surface-3-foreground">
        <div className="mx-auto max-w-marketing px-5 sm:px-8">
          <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
            <div className="max-w-xs">
              <Logo />
              <p className="mt-4 text-sm text-surface-3-muted">{footer.note}</p>
            </div>

            <div className="flex gap-14">
              {footer.groups.map((group) => (
                <div key={group.title}>
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
              © {new Date().getFullYear()} {siteConfig.name}
            </p>
            <p>Built for owners, not analysts.</p>
          </div>
        </div>
      </footer>
    </>
  )
}
