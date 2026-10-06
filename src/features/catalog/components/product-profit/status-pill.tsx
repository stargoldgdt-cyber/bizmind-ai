import { CircleAlert, CircleCheck, CircleDashed, Link2, TrendingDown, TrendingUp } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { STATUS_LABEL, type ProfitStatus } from "@/services/catalog/product-profit-view"

/**
 * A product's status as a pill. State is carried by the word AND an icon, never
 * by colour alone (DESIGN.md): success, warning and danger colours keep their
 * meaning, and "needs setting up" is deliberately neutral.
 */
const STYLE: Record<ProfitStatus, { icon: LucideIcon; className: string }> = {
  LOSS: { icon: TrendingDown, className: "bg-danger-subtle text-danger-strong" },
  LOW_MARGIN: { icon: CircleAlert, className: "bg-warning-subtle text-warning-strong" },
  GOOD: { icon: CircleCheck, className: "bg-success-subtle text-success-strong" },
  HIGH_MARGIN: { icon: TrendingUp, className: "bg-success-subtle text-success-strong" },
  MISSING_COST: { icon: CircleDashed, className: "bg-muted text-muted-foreground" },
  NEEDS_MAPPING: { icon: Link2, className: "bg-muted text-muted-foreground" },
}

export function StatusPill({ status }: { status: ProfitStatus }) {
  const { icon: Icon, className } = STYLE[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap ${className}`}
    >
      <Icon className="size-3.5" aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  )
}
