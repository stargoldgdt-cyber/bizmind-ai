/**
 * Period resolution and comparison windows.
 *
 * Comparing like with like is the whole job here. Thirty days against the
 * previous thirty is meaningful; thirty days against a calendar month is not,
 * and a partial month against a complete one flatters or damns the business
 * for no reason. Every period therefore carries an `incomplete` flag, and the
 * interface says so rather than letting a half-finished month look like a
 * collapse.
 *
 * All boundaries are half-open: `from <= t < to`. That way consecutive periods
 * neither overlap nor leave a gap, so an order can never be counted twice or
 * fall between two reports.
 */

export type PeriodKey =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "90d"
  | "365d"
  | "this_month"
  | "last_month"

export type ResolvedPeriod = {
  key: PeriodKey | "custom"
  label: string
  /** How the previous window was chosen, shown next to any comparison. */
  comparisonLabel: string
  from: string
  to: string
  previousFrom: string
  previousTo: string
  /**
   * True when the window extends past the present moment — a month still in
   * progress, or today. Comparisons against a complete previous period are
   * then unfair, and the interface must say so.
   */
  incomplete: boolean
}

const DAY = 24 * 60 * 60 * 1000

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
}

export const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "365d", label: "Last 12 months" },
]

export const DEFAULT_PERIOD: PeriodKey = "30d"

export function isPeriodKey(value: unknown): value is PeriodKey {
  return PERIOD_OPTIONS.some((option) => option.value === value)
}

/**
 * Turns a period name into concrete bounds plus the window it compares to.
 *
 * Rolling windows compare against the equally long window immediately before.
 * Calendar periods compare against the previous calendar period, because "this
 * month vs last month" is what an owner means — even though months differ in
 * length. That choice is stated in `comparisonLabel` rather than hidden.
 */
export function resolvePeriod(key: PeriodKey, now = new Date()): ResolvedPeriod {
  const todayStart = startOfUtcDay(now)

  switch (key) {
    case "today": {
      const from = todayStart
      const to = new Date(todayStart.getTime() + DAY)
      return build("today", "Today", "vs yesterday", from, to, new Date(from.getTime() - DAY), from, true)
    }

    case "yesterday": {
      const from = new Date(todayStart.getTime() - DAY)
      return build(
        "yesterday",
        "Yesterday",
        "vs the day before",
        from,
        todayStart,
        new Date(from.getTime() - DAY),
        from,
        false
      )
    }

    case "this_month": {
      const from = startOfUtcMonth(now)
      const to = addMonths(from, 1)
      const previousFrom = addMonths(from, -1)
      // A month in progress is being compared with a complete one.
      return build("this_month", "This month", "vs last month", from, to, previousFrom, from, true)
    }

    case "last_month": {
      const thisMonth = startOfUtcMonth(now)
      const from = addMonths(thisMonth, -1)
      return build(
        "last_month",
        "Last month",
        "vs the month before",
        from,
        thisMonth,
        addMonths(from, -1),
        from,
        false
      )
    }

    default: {
      const days = key === "7d" ? 7 : key === "90d" ? 90 : key === "365d" ? 365 : 30
      const label = key === "365d" ? "Last 12 months" : `Last ${days} days`
      // Rolling windows end now, so the final day is partial by definition.
      const to = new Date(now.getTime())
      const from = new Date(to.getTime() - days * DAY)
      const previousFrom = new Date(from.getTime() - days * DAY)
      return build(key, label, `vs the previous ${days} days`, from, to, previousFrom, from, true)
    }
  }
}

/**
 * A user-chosen date range, compared against the equally long window before it.
 *
 * The end date is treated as inclusive of that whole day, which is what a
 * person selecting "1st to 7th" means.
 */
export function resolveCustomPeriod(fromDate: Date, toDate: Date, now = new Date()): ResolvedPeriod {
  const from = startOfUtcDay(fromDate)
  const to = new Date(startOfUtcDay(toDate).getTime() + DAY)
  const span = Math.max(to.getTime() - from.getTime(), DAY)
  const previousFrom = new Date(from.getTime() - span)

  return build(
    "custom",
    `${from.toISOString().slice(0, 10)} to ${new Date(to.getTime() - DAY).toISOString().slice(0, 10)}`,
    "vs the previous equivalent range",
    from,
    to,
    previousFrom,
    from,
    to.getTime() > now.getTime()
  )
}

function build(
  key: ResolvedPeriod["key"],
  label: string,
  comparisonLabel: string,
  from: Date,
  to: Date,
  previousFrom: Date,
  previousTo: Date,
  incomplete: boolean
): ResolvedPeriod {
  return {
    key,
    label,
    comparisonLabel,
    from: from.toISOString(),
    to: to.toISOString(),
    previousFrom: previousFrom.toISOString(),
    previousTo: previousTo.toISOString(),
    incomplete,
  }
}
