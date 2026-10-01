import { ArrowRight, CalendarDays, ChevronDown, PiggyBank, Receipt, Sparkles, TrendingDown, TrendingUp, Wallet } from "lucide-react"
import type { ComponentType, SVGProps } from "react"

import { cn } from "cn"

/**
 * The hero's product visual: the executive dashboard, drawn.
 *
 * WHAT IT IS
 * ----------
 * A faithful rendering of what BizMind shows on /overview (rebuilt
 * 2026-09-30, light, per the owner's reference): a real greeting, the
 * headline KPI cards with their own icon tiles and sparklines, and the
 * insight card that explains the sharpest change in plain language -- the
 * same three pieces, in the same order, a signed-in seller actually sees
 * first. Every label, unit and relationship is real; the values describe a
 * demonstration business and the frame says so.
 *
 * WHY IT IS DRAWN AND NOT A SCREENSHOT
 * ------------------------------------
 * A screenshot is a picture of one viewport at one moment. This is markup, so
 * it reflows on a phone, respects the reader's theme, and stays legible when
 * text is enlarged. It also cannot go stale in the way a PNG does, and it
 * never has to be retaken when the real dashboard changes again.
 *
 * LIGHT, MATCHED TO THE OWNER'S REFERENCE
 * -----------------------------------------
 * Previously a dark `surface-3` panel (matching an earlier all-dark preview
 * section). The owner's reference (2026-09-30) puts this same console on a
 * white card, on the same light lavender band as the hero, Problem and Loop
 * sections -- so this rebuild follows that, not a fresh design of its own.
 */

const SPARK: Record<
  string,
  { area: string; line: string; color: string }
> = {
  /** Real hex, matching --success/--danger/--primary/--info's light-mode values -- SVG stop-color doesn't reliably resolve a CSS var (see problem.tsx). */
  up: {
    area: "M2 46 C14 40 22 30 32 32 S48 40 58 28 S72 18 82 20 S96 14 108 16 S124 10 138 8 V60 H2Z",
    line: "M2 46 C14 40 22 30 32 32 S48 40 58 28 S72 18 82 20 S96 14 108 16 S124 10 138 8",
    color: "#15803d",
  },
  down: {
    area: "M2 14 C14 20 22 26 32 24 S48 30 58 34 S72 40 82 38 S96 44 108 42 S124 48 138 50 V60 H2Z",
    line: "M2 14 C14 20 22 26 32 24 S48 30 58 34 S72 40 82 38 S96 44 108 42 S124 48 138 50",
    color: "#b91c1c",
  },
  downViolet: {
    area: "M2 16 C14 22 22 20 32 26 S48 24 58 32 S72 30 82 38 S96 40 108 44 S124 42 138 48 V60 H2Z",
    line: "M2 16 C14 22 22 20 32 26 S48 24 58 32 S72 30 82 38 S96 40 108 44 S124 42 138 48",
    color: "#6d28d9",
  },
  flat: {
    area: "M2 34 C20 30 34 38 50 32 S78 28 96 34 S120 30 138 32 V60 H2Z",
    line: "M2 34 C20 30 34 38 50 32 S78 28 96 34 S120 30 138 32",
    color: "#2563eb",
  },
}

function Sparkline({ id, spark }: { id: string; spark: keyof typeof SPARK }) {
  const s = SPARK[spark]
  return (
    <svg viewBox="0 0 140 60" className="absolute right-0 bottom-0 h-12 w-24 opacity-80" aria-hidden>
      <defs>
        <linearGradient id={`console-spark-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop stopColor={s.color} stopOpacity="0.18" />
          <stop offset="1" stopColor={s.color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={s.area} fill={`url(#console-spark-${id})`} />
      <path d={s.line} fill="none" stroke={s.color} strokeWidth="2" />
    </svg>
  )
}

const KPIS: {
  key: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  label: string
  value: string
  change: string
  good: boolean | null
  spark: keyof typeof SPARK
}[] = [
  { key: "net", icon: Receipt, label: "Net sales", value: "184,320", change: "21.6%", good: true, spark: "up" },
  { key: "contribution", icon: PiggyBank, label: "Contribution", value: "114,470", change: "6.1%", good: false, spark: "down" },
  { key: "gross", icon: TrendingUp, label: "Gross profit", value: "44,430", change: "12.8%", good: false, spark: "downViolet" },
  { key: "payouts", icon: Wallet, label: "Expected payouts", value: "96,210", change: "Not received", good: null, spark: "flat" },
]

const TONE: Record<string, string> = {
  net: "bg-success-subtle text-success-strong",
  contribution: "bg-rose-100 text-rose-600",
  gross: "bg-primary/10 text-primary",
  payouts: "bg-info-subtle text-info-strong",
}

export function ProfitConsole() {
  return (
    <div className="overflow-hidden rounded-3xl border border-surface-1-border bg-surface-1 shadow-[0_30px_60px_-35px_rgba(76,29,149,0.3)]">
      {/* Window chrome, doubling as the real-time greeting your own dashboard shows. */}
      <div className="flex items-center justify-between gap-3 border-b border-surface-1-border px-4 py-3.5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-[11px] font-bold text-primary-foreground">
            YA
          </span>
          <div>
            <p className="text-sm font-semibold">Good afternoon, Yousef 👋</p>
            <p className="text-xs text-surface-1-muted">Business performance · demo</p>
          </div>
        </div>
        <span className="hidden items-center gap-1.5 rounded-full border border-surface-1-border px-3 py-1.5 font-mono text-xs text-surface-1-muted sm:flex">
          <CalendarDays className="size-3.5" aria-hidden />
          Last 3 months
          <ChevronDown className="size-3.5" aria-hidden />
        </span>
      </div>

      <div className="p-4 sm:p-6">
        {/* Headline figures, each with its own icon tile and sparkline -- the same card the real dashboard uses. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {KPIS.map((kpi) => (
            <div key={kpi.key} className="relative min-w-0 overflow-hidden rounded-2xl border border-surface-1-border p-3.5">
              <div className="flex items-start gap-2">
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TONE[kpi.key])}>
                  <kpi.icon className="size-4" aria-hidden />
                </span>
                <p className="min-w-0 text-pretty font-mono text-[10px] leading-tight tracking-wide text-surface-1-muted uppercase">
                  {kpi.label}
                </p>
              </div>
              <p className="relative mt-3 font-mono text-lg font-bold tabular-nums sm:text-xl">{kpi.value}</p>
              <p
                className={cn(
                  "relative mt-1 flex items-center gap-1 font-mono text-xs tabular-nums",
                  kpi.good === null ? "text-surface-1-muted" : kpi.good ? "text-success" : "text-danger"
                )}
              >
                {kpi.good === null ? null : kpi.good ? (
                  <TrendingUp className="size-3" aria-hidden />
                ) : (
                  <TrendingDown className="size-3" aria-hidden />
                )}
                {kpi.change}
              </p>
              <Sparkline id={kpi.key} spark={kpi.spark} />
            </div>
          ))}
        </div>

        {/* The insight card: the one sentence that explains the sharpest change, exactly as the real dashboard writes it. */}
        <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Sparkles className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="font-mono text-[10.5px] tracking-wider text-primary uppercase">BizMind insight</p>
              <p className="mt-1.5 text-sm text-pretty">
                <span className="font-semibold">Contribution is down 6.1% vs last period.</span>{" "}
                <span className="text-surface-1-muted">
                  The biggest reason: fulfilment on noon rose faster than sales, and advertising on Amazon added AED
                  4,120.
                </span>
              </p>
            </div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 self-start rounded-full bg-primary/10 px-4 py-2 text-xs font-semibold text-primary sm:self-center">
            See why
            <ArrowRight className="size-3" aria-hidden />
          </span>
        </div>
      </div>
    </div>
  )
}
