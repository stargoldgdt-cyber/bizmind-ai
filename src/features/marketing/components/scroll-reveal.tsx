"use client"

import { useEffect } from "react"

/**
 * Scroll reveals for the marketing page (owner request, 2026-10-06; the rule
 * they relax is recorded in DESIGN.md section 11 and DECISIONS.md).
 *
 * HOW IT WORKS
 * ------------
 * Sections mark what should reveal with a plain attribute -- `data-reveal="2"`,
 * the number being its place in a staggered group -- so the sections stay server
 * components and no wrapper component is needed. This one component, mounted
 * once, finds them all.
 *
 * PROGRESSIVE ENHANCEMENT
 * -----------------------
 * Nothing is hidden until this runs. The server renders everything visible, so
 * with scripts off, before hydration, or in a crawler, the page is complete.
 * Only elements still BELOW the viewport when this mounts are hidden, which is
 * never visible to the visitor, so there is no flash. Anything already in view
 * (the hero) is left alone. Each element reveals once and is then released;
 * scrolling back up replays nothing.
 *
 * It does nothing at all for visitors who ask their system to reduce motion.
 * It only sets attributes on elements, never React state, and it touches no
 * layout (opacity and a short rise), so nothing shifts.
 */

const STAGGER_MS = 80
const MAX_STEP = 5

export function ScrollReveal() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    if (typeof IntersectionObserver === "undefined") return

    const pending = new Set<HTMLElement>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const el = entry.target as HTMLElement
          el.dataset.revealState = "shown"
          observer.unobserve(el)
          pending.delete(el)
        }
      },
      // Reveal a little after an element enters, so it does not fire at the very edge.
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    )

    for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
      if (el.getBoundingClientRect().top < window.innerHeight) continue
      const step = Math.min(Number(el.dataset.reveal) || 0, MAX_STEP)
      el.style.setProperty("--reveal-delay", `${step * STAGGER_MS}ms`)
      el.dataset.revealState = "hidden"
      pending.add(el)
      observer.observe(el)
    }

    return () => {
      observer.disconnect()
      // Leave nothing hidden if the page unmounts (a client-side navigation away).
      for (const el of pending) el.dataset.revealState = "shown"
    }
  }, [])

  return null
}
