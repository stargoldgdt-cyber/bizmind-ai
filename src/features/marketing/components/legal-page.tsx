import Link from "next/link"

import { legal } from "@/config/legal"
import { siteConfig } from "@/config/site"
import { MarketingNav } from "@/features/marketing/components/nav"
import type { LegalDocument } from "@/features/marketing/legal"

/**
 * A legal page: the marketing navigation, one readable column of text, and a
 * plain footer. While src/config/legal.ts is marked draft, a notice says so,
 * because a policy with placeholder company details must not look final.
 */
export function LegalPage({ document }: { document: LegalDocument }) {
  return (
    <div className="min-h-dvh bg-surface-1 text-surface-1-foreground">
      <MarketingNav />
      <main id="main" className="mx-auto max-w-3xl px-5 py-14 sm:px-8 sm:py-20">
        <h1 className="font-heading text-3xl font-bold tracking-tight sm:text-4xl">{document.title}</h1>
        <p className="mt-4 text-lg text-pretty text-surface-1-muted">{document.summary}</p>

        {legal.draft && (
          <p role="note" className="mt-6 rounded-xl border border-warning/35 bg-warning-subtle px-4 py-3 text-sm text-warning-strong">
            Draft: the company details in brackets are still to be confirmed, and this text is awaiting
            review.
          </p>
        )}

        <div className="mt-10 grid gap-9">
          {document.sections.map((section) => (
            <section key={section.heading}>
              <h2 className="font-heading text-xl font-semibold">{section.heading}</h2>
              {section.paragraphs?.map((p) => (
                <p key={p.slice(0, 40)} className="mt-3 leading-relaxed text-pretty text-surface-1-muted">
                  {p}
                </p>
              ))}
              {section.bullets && (
                <ul className="mt-3 grid list-disc gap-2 pl-5 leading-relaxed text-surface-1-muted marker:text-primary">
                  {section.bullets.map((b) => (
                    <li key={b.slice(0, 40)}>{b}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-surface-1-muted sm:px-8">
          <p>
            © {new Date().getFullYear()} {siteConfig.name}
          </p>
          <nav className="flex gap-5" aria-label="Legal">
            <Link href="/" className="hover:text-surface-1-foreground">
              Home
            </Link>
            <Link href="/privacy" className="hover:text-surface-1-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-surface-1-foreground">
              Terms
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
