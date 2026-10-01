"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { Menu, X } from "lucide-react"

import { cn } from "cn"
import { Logo } from "@/components/brand/logo"
import { Button } from "@/components/ui/button"

import { nav } from "../content"

/**
 * The marketing header.
 *
 * Five items and one action. Navigation on a landing page is not a site map —
 * it is a set of escape hatches for someone who has already decided what they
 * want to check before they commit.
 *
 * LIGHT, MATCHED TO THE HERO
 * ---------------------------
 * Owner direction, 2026-09-30: the hero moved from a dark band to a light
 * one, and the header moves with it -- same identity as the band it sits on,
 * so there's no seam between them. The only thing that changes on scroll is
 * the hairline underneath, once there is content behind it to separate from.
 */
export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  // A menu that stays open behind a navigation is a trap on mobile.
  const close = () => setOpen(false)

  return (
    <header
      className={cn(
        "sticky top-0 z-50 bg-surface-1 text-surface-1-foreground transition-shadow",
        scrolled && "border-b border-surface-1-border"
      )}
    >
      <div className="mx-auto flex h-16 max-w-marketing items-center justify-between gap-6 px-5 sm:px-8">
        <Link href="/" className="shrink-0" aria-label="BizMind AI home">
          <Logo />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
          {nav.links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-surface-1-muted transition-colors hover:text-surface-1-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Button asChild variant="outline" size="sm" className="rounded-4xl border-surface-1-border px-4">
            <Link href={nav.signIn.href}>{nav.signIn.label}</Link>
          </Button>
          <Button asChild size="sm" className="rounded-4xl px-4">
            <Link href={nav.cta.href}>{nav.cta.label}</Link>
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="marketing-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          className="-mr-2 inline-flex size-10 items-center justify-center rounded-md text-surface-1-foreground md:hidden"
        >
          {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
        </button>
      </div>

      {/* Mobile menu. Full-width rows, thumb-sized, not a shrunken desktop nav. */}
      <div
        id="marketing-menu"
        hidden={!open}
        className="border-t border-surface-1-border bg-surface-1 md:hidden"
      >
        {/*
          A distinct label. Two navigation landmarks both called "Main" are
          announced identically, so a screen-reader user cannot tell which one
          they have landed in.
        */}
        <nav aria-label="Menu" className="mx-auto max-w-marketing px-5 py-3 sm:px-8">
          {nav.links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={close}
              className="block border-b border-surface-1-border py-3.5 text-base text-surface-1-foreground last:border-0"
            >
              {link.label}
            </a>
          ))}

          <div className="mt-4 flex flex-col gap-2 pb-2">
            <Button asChild size="lg" className="h-11 rounded-4xl">
              <Link href={nav.cta.href} onClick={close}>
                {nav.cta.label}
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-11 rounded-4xl border-surface-1-border">
              <Link href={nav.signIn.href} onClick={close}>
                {nav.signIn.label}
              </Link>
            </Button>
          </div>
        </nav>
      </div>
    </header>
  )
}
