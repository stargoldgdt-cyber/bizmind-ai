import { cn } from "cn"

/**
 * The BizMind mark.
 *
 * An original geometric glyph: a rising signal built from three ascending
 * bars, enclosed by a rounded aperture. It reads as "data going up" and as a
 * lens on a business — the connect/understand/act loop the product runs.
 *
 * Drawn with `currentColor` so it inherits the surrounding text colour and
 * works on light surfaces, dark sections and disabled states alike.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label={`${"BizMind"} logo`}
      className={cn("size-8", className)}
    >
      <rect
        x="1.25"
        y="1.25"
        width="29.5"
        height="29.5"
        rx="9"
        stroke="currentColor"
        strokeWidth="2.5"
        opacity="0.28"
      />
      <rect x="8" y="17" width="3.5" height="7" rx="1.75" fill="currentColor" opacity="0.5" />
      <rect x="14.25" y="12" width="3.5" height="12" rx="1.75" fill="currentColor" opacity="0.75" />
      <rect x="20.5" y="7" width="3.5" height="17" rx="1.75" fill="currentColor" />
    </svg>
  )
}

/** The mark paired with the product name. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className="size-8 text-primary" />
      <span className="font-heading text-lg font-bold tracking-tight">
        BizMind<span className="text-primary"> AI</span>
      </span>
    </span>
  )
}
