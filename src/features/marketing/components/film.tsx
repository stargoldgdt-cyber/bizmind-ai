"use client"

import { useState } from "react"
import { Play } from "lucide-react"

import { cn } from "cn"

import { film } from "../content"
import { SectionHeader } from "./section"
import { ProfitConsole } from "./profit-console"

/**
 * The product film.
 *
 * THERE IS NO VIDEO FILE YET, AND THIS DOES NOT PRETEND OTHERWISE.
 *
 * The frame is production-ready: a real 16:9 container, a real play control
 * with an accessible name, real chapter markers. What sits behind the play
 * button is the actual product console rather than a blurred stock still, so
 * a visitor who never presses play has still seen the product.
 *
 * WIRING THE REAL VIDEO
 * ---------------------
 * Drop the file in, pass `src`, and the poster state below is replaced by a
 * `<video controls preload="none" poster="…">`. Nothing else needs to change:
 * the aspect ratio, the chapter rail and the responsive behaviour are already
 * correct. Until then `src` is undefined and pressing play says so honestly
 * rather than failing silently.
 */
export function Film({ src }: { src?: string }) {
  const [playing, setPlaying] = useState(false)

  return (
    <section
      id="film"
      className="bg-surface-3 py-section-md text-surface-3-foreground"
      style={{ scrollMarginTop: "4rem" }}
    >
      <div className="mx-auto max-w-marketing px-5 sm:px-8">
        <SectionHeader
          level="3"
          eyebrow={film.eyebrow}
          headline={film.headline}
          support={film.support}
          align="center"
        />

        <div className="mt-12">
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-surface-3-border bg-surface-3-raised">
            {playing && src ? (
              <video
                className="size-full"
                src={src}
                controls
                autoPlay
                playsInline
                preload="none"
              />
            ) : (
              <>
                {/* The product, scaled into the frame as the poster. */}
                <div
                  className="pointer-events-none absolute inset-0 origin-top scale-[0.72] p-6 opacity-70 sm:scale-90 sm:p-10"
                  aria-hidden
                >
                  <ProfitConsole />
                </div>

                <div className="absolute inset-0 bg-surface-3/55" aria-hidden />

                <button
                  type="button"
                  onClick={() => setPlaying(true)}
                  disabled={!src}
                  className={cn(
                    "absolute inset-0 flex flex-col items-center justify-center gap-4",
                    "focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:outline-none",
                    src ? "cursor-pointer" : "cursor-default"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-16 items-center justify-center rounded-full border border-surface-3-border bg-surface-3-raised transition-transform sm:size-20",
                      src && "hover:scale-105"
                    )}
                  >
                    <Play className="ml-1 size-6 fill-current sm:size-7" aria-hidden />
                  </span>

                  <span className="text-sm text-surface-3-muted">
                    {src ? "Play the tour — 90 seconds" : "Tour coming soon"}
                  </span>
                </button>
              </>
            )}
          </div>

          {/* What the film covers, so the length is a promise rather than a risk. */}
          <ol className="mt-6 grid gap-px overflow-hidden rounded-xl border border-surface-3-border bg-surface-3-border sm:grid-cols-5">
            {film.chapters.map((chapter, index) => (
              <li
                key={chapter}
                className="flex items-baseline gap-2.5 bg-surface-3 px-4 py-3.5"
              >
                <span className="font-mono text-[11px] tabular-nums text-brand-300">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-sm text-surface-3-muted">{chapter}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}
