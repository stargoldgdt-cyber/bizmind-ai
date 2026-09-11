import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react"

import { cn } from "cn"

/**
 * The hero's product visual.
 *
 * WHAT IT IS
 * ----------
 * A faithful rendering of what BizMind actually shows: the figures come from
 * the analytics engine's real vocabulary (revenue, gross margin, marketplace
 * fees, cost coverage), laid out the way the dashboard lays them out — label,
 * then the number as the loudest element, then the change beside it.
 *
 * The values describe a demonstration business. Every LABEL, every unit and
 * every relationship between them is real; nothing here is a figure BizMind
 * could not produce.
 *
 * WHY IT IS DRAWN AND NOT A SCREENSHOT
 * ------------------------------------
 * A screenshot is a picture of one viewport at one moment. This is markup, so
 * it reflows on a phone, respects the reader's theme, and stays legible when
 * text is enlarged. It also cannot go stale in the way a PNG does.
 *
 * THE COMPOSITION IS THE ARGUMENT
 * -------------------------------
 * A margin sits beside the coverage figure that qualifies it, and the panel
 * ends on a recommendation. That order — figure, caveat, what to do — is the
 * whole product in one frame.
 */

const KPIS = [
  { label: "Revenue", value: "284,500", unit: "AED", change: "+18.2%", up: true, good: true },
  { label: "Orders", value: "1,284", unit: "", change: "+12.4%", up: true, good: true },
  { label: "Marketplace fees", value: "31,295", unit: "AED", change: "+26.0%", up: true, good: false },
  { label: "Net profit", value: "24,180", unit: "AED", change: "−9.2%", up: false, good: false },
] as const

const CHANNELS = [
  { name: "Amazon", revenue: "142,250", margin: "8.1%", width: "w-[50%]", weak: true },
  { name: "Website", revenue: "96,730", margin: "19.4%", width: "w-[34%]", weak: false },
  { name: "Retail", revenue: "45,520", margin: "14.2%", width: "w-[16%]", weak: false },
] as const

export function ProfitConsole() {
  return (
    <div className="overflow-hidden rounded-2xl border border-surface-3-border bg-surface-3-raised">
      {/* Window chrome. Establishes "this is an application", quietly. */}
      <div className="flex items-center justify-between border-b border-surface-3-border px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2.5">
          <span className="size-2 rounded-full bg-success" aria-hidden />
          <p className="font-mono text-[11px] tracking-wider text-surface-3-muted uppercase">
            Profit intelligence
          </p>
        </div>
        <p className="font-mono text-[11px] text-surface-3-muted">Last 30 days</p>
      </div>

      <div className="p-4 sm:p-5">
        {/* Four figures. Tabular so the digits line up down the columns. */}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-surface-3-border bg-surface-3-border sm:grid-cols-4">
          {KPIS.map((kpi) => (
            <div key={kpi.label} className="bg-surface-3-raised p-3.5">
              <p className="truncate text-[11px] text-surface-3-muted">{kpi.label}</p>
              <p className="mt-1.5 font-mono text-lg font-semibold tabular-nums">
                {kpi.value}
                {kpi.unit && (
                  <span className="ml-1 text-[11px] font-normal text-surface-3-muted">
                    {kpi.unit}
                  </span>
                )}
              </p>
              <p
                className={cn(
                  "mt-1 flex items-center gap-1 font-mono text-[11px] tabular-nums",
                  kpi.good ? "text-success" : "text-danger"
                )}
              >
                {kpi.up ? (
                  <TrendingUp className="size-3" aria-hidden />
                ) : (
                  <TrendingDown className="size-3" aria-hidden />
                )}
                {kpi.change}
              </p>
            </div>
          ))}
        </div>

        {/* Where the money actually comes from, and what it keeps. */}
        <div className="mt-4 rounded-xl border border-surface-3-border p-4">
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-[11px] tracking-wider text-surface-3-muted uppercase">
              By channel
            </p>
            <p className="font-mono text-[11px] text-surface-3-muted">Gross margin</p>
          </div>

          <ul className="mt-3.5 space-y-3">
            {CHANNELS.map((channel) => (
              <li key={channel.name}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate">{channel.name}</span>
                  <span className="flex shrink-0 items-baseline gap-3 font-mono text-xs tabular-nums">
                    <span className="text-surface-3-muted">{channel.revenue}</span>
                    <span
                      className={cn(
                        "w-12 text-right",
                        channel.weak ? "text-warning" : "text-surface-3-foreground"
                      )}
                    >
                      {channel.margin}
                    </span>
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3-border">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      channel.width,
                      channel.weak ? "bg-warning" : "bg-brand-400"
                    )}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/*
          The point of the whole panel. A figure, the reason it is not the
          whole truth, and the thing to do about it.
        */}
        <div className="mt-4 flex gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="text-sm font-medium">
              Amazon takes half your revenue and returns the least margin.
            </p>
            <p className="mt-1 text-xs text-surface-3-muted">
              Fees there rose 26% while revenue rose 18%. Based on 82% cost
              coverage — one in six items sold has no cost recorded, so the real
              margin is lower.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
