import { ArrowDown, ArrowUp, Minus } from "lucide-react"

import { cn } from "cn"

/**
 * Period-over-period change.
 *
 * Carries an ARROW as well as a colour. Colour alone never signals meaning in
 * this product — roughly one man in twelve has some colour-vision deficiency,
 * and a red-versus-green chip is exactly the case that fails them.
 *
 * `higherIsBetter` exists because direction is not universal: rising revenue is
 * good, rising expenses is not. Getting this wrong would tell an owner their
 * costs are improving while they climb.
 */
export function DeltaChip({
  change,
  higherIsBetter = true,
  className,
}: {
  change: number | null
  higherIsBetter?: boolean
  className?: string
}) {
  // No comparable prior period. Say so rather than invent a number.
  if (change === null) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        no prior data
      </span>
    )
  }

  const rounded = Math.round(change * 10) / 10
  const flat = Math.abs(rounded) < 0.05
  const rising = rounded > 0
  const good = flat ? null : rising === higherIsBetter

  const Icon = flat ? Minus : rising ? ArrowUp : ArrowDown

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-4xl px-2 py-0.5 text-xs font-medium tabular-nums",
        good === null && "bg-muted text-muted-foreground",
        good === true && "bg-success-subtle text-success-strong",
        good === false && "bg-danger-subtle text-danger-strong",
        className
      )}
    >
      <Icon className="size-3" aria-hidden />
      {flat ? "no change" : `${rising ? "+" : ""}${rounded}%`}
    </span>
  )
}
