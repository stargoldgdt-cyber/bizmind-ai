import Link from "next/link"
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"

import { formatMoney, formatPercent } from "@/lib/format"
import type { ChangeDriver, MetricComparison } from "@/services/analytics"

/**
 * What changed, how much, and what moved it.
 *
 * EVERY SENTENCE IS ASSEMBLED FROM VERIFIED FIGURES.
 *
 * The percentages, the amounts and the shares all arrive computed from
 * `analytics_compare()` and `analytics_change_drivers()`. This component
 * chooses which of them to say and in what order; it never works one out. That
 * is the difference between "revenue rose 18%, mostly Amazon" being a fact and
 * being a guess that happens to read well.
 *
 * A driver built on lines with no recorded value says so, because "Amazon drove
 * the increase" means something different when a tenth of its lines have no
 * value at all.
 */

const KIND_LABEL: Record<ChangeDriver["driver_kind"], string> = {
  CHANNEL: "channel",
  PRODUCT: "product",
}

export function WhatChanged({
  comparisons,
  drivers,
  currency,
  hrefForChannel,
}: {
  comparisons: MetricComparison[]
  drivers: ChangeDriver[]
  currency: string
  /** Links a channel driver back to the filtered dashboard. */
  hrefForChannel: (channelKey: string) => string
}) {
  const revenue = comparisons.find((c) => c.metric === "revenue")
  const profit = comparisons.find((c) => c.metric === "gross_profit")
  const margin = comparisons.find((c) => c.metric === "gross_margin")

  const revenueDrivers = drivers.filter(
    (d) => d.metric === "revenue" && d.driver_kind === "CHANNEL"
  )
  const profitDrivers = drivers.filter(
    (d) => d.metric === "gross_profit" && d.driver_kind === "CHANNEL"
  )
  const productDrivers = drivers.filter(
    (d) => d.metric === "gross_profit" && d.driver_kind === "PRODUCT"
  )

  const nothingToSay =
    (revenue?.percent_change ?? null) === null &&
    (profit?.percent_change ?? null) === null &&
    drivers.length === 0

  if (nothingToSay) {
    return (
      <p className="rounded-xl border border-border bg-card px-5 py-6 text-sm text-muted-foreground">
        There is nothing to compare yet: the previous period had no activity to
        measure this one against. Come back after a full comparable period.
      </p>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid gap-px bg-border sm:grid-cols-3">
        <Headline
          label="Revenue"
          comparison={revenue}
          currency={currency}
          suffix="money"
        />
        <Headline
          label="Gross profit"
          comparison={profit}
          currency={currency}
          suffix="money"
        />
        <Headline label="Gross margin" comparison={margin} currency={currency} suffix="points" />
      </div>

      <div className="divide-y divide-border">
        <DriverRow
          title="What moved revenue"
          drivers={revenueDrivers}
          currency={currency}
          hrefForChannel={hrefForChannel}
        />
        <DriverRow
          title="What moved profit"
          drivers={profitDrivers}
          currency={currency}
          hrefForChannel={hrefForChannel}
        />
        <DriverRow
          title="Products behind the profit change"
          drivers={productDrivers}
          currency={currency}
        />
      </div>
    </div>
  )
}

function Headline({
  label,
  comparison,
  currency,
  suffix,
}: {
  label: string
  comparison: MetricComparison | undefined
  currency: string
  suffix: "money" | "points"
}) {
  const percent = comparison?.percent_change ?? null
  const direction = comparison?.direction ?? "unknown"

  const Icon =
    direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus
  const tone =
    direction === "up"
      ? "text-success-strong"
      : direction === "down"
        ? "text-danger-strong"
        : "text-muted-foreground"

  return (
    <div className="bg-card px-5 py-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
        {suffix === "money"
          ? formatMoney(comparison?.current_value ?? null, currency)
          : formatPercent(comparison?.current_value ?? null)}
      </p>
      <p className={`mt-1 flex items-center gap-1 text-xs ${tone}`}>
        <Icon className="size-3.5" aria-hidden />
        {percent === null ? (
          <span className="text-muted-foreground">
            no comparison — the previous period had none
          </span>
        ) : (
          <span className="font-mono tabular-nums">
            {formatPercent(percent)} against the previous period
          </span>
        )}
      </p>
    </div>
  )
}

function DriverRow({
  title,
  drivers,
  currency,
  hrefForChannel,
}: {
  title: string
  drivers: ChangeDriver[]
  currency: string
  hrefForChannel?: (channelKey: string) => string
}) {
  if (drivers.length === 0) return null

  const top = drivers.slice(0, 3)

  return (
    <div className="px-5 py-4">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="mt-2 space-y-1.5">
        {top.map((driver) => {
          const rose = driver.direction === "up"
          const label = hrefForChannel ? (
            <Link
              href={hrefForChannel(driver.driver_key)}
              className="font-medium underline-offset-4 hover:underline"
            >
              {driver.driver_label}
            </Link>
          ) : (
            <span className="font-medium">{driver.driver_label}</span>
          )

          return (
            <li
              key={`${driver.driver_kind}-${driver.driver_key}`}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm"
            >
              <span>
                {label}{" "}
                <span className="text-muted-foreground">
                  {rose ? "added" : "lost"} {formatMoney(driver.change_amount.replace("-", ""), currency)}
                  {driver.share_of_change !== null && (
                    <>
                      {" "}
                      — {formatPercent(driver.share_of_change)} of the{" "}
                      {KIND_LABEL[driver.driver_kind]} movement
                    </>
                  )}
                </span>
              </span>

              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {formatMoney(driver.previous_value, currency)} →{" "}
                {formatMoney(driver.current_value, currency)}
                {driver.incomplete && (
                  <span className="ml-2 text-warning-strong">
                    some lines have no recorded value
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
