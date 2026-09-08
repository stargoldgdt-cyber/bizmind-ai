/**
 * Design tokens, for code that cannot read CSS classes.
 *
 * IMPORTANT: these are CSS variable *references*, not colour values. The real
 * values live in `src/app/globals.css`, which stays the single source of
 * truth. Charting libraries take a colour string, so they get `var(--chart-1)`
 * and automatically follow the active light/dark theme.
 *
 * Never write a hex code in this file. If you need a new colour, add it to
 * globals.css first and reference it here.
 */

/**
 * Categorical chart series, in fixed order.
 *
 * Rules that must not be broken (see DESIGN.md):
 *  - Assign these in order. Never cycle back to slot 1 for a 7th series —
 *    group the remainder into "Other" or split into separate charts.
 *  - Colour follows the entity, not its rank. Filtering a chart must not
 *    repaint the series that remain.
 *  - Never reuse a status colour (success/warning/danger/info) as a series.
 */
export const chartSeries = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const

/** The maximum number of distinct series a single chart may show. */
export const MAX_CHART_SERIES = chartSeries.length

/**
 * Reserved state colours. These carry meaning, so they always ship with an
 * icon or a text label — never colour on its own.
 */
export const statusColors = {
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  info: "var(--info)",
} as const

export type StatusTone = keyof typeof statusColors

/** Neutral ink for chart text. Labels never wear the series colour. */
export const chartInk = {
  primary: "var(--foreground)",
  secondary: "var(--muted-foreground)",
  grid: "var(--border)",
  surface: "var(--card)",
} as const

/**
 * Returns the series colour for a given index.
 *
 * Throws past the supported count rather than silently cycling, because two
 * series sharing a colour is a correctness bug in a business chart, not a
 * cosmetic one.
 */
export function getSeriesColor(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CHART_SERIES) {
    throw new RangeError(
      `Chart series index ${index} is out of range. BizMind charts support ` +
        `${MAX_CHART_SERIES} distinct series; group the remainder into "Other" ` +
        `or split the data across multiple charts.`
    )
  }

  return chartSeries[index]
}
