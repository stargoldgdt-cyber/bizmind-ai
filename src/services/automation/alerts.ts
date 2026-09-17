import "server-only"

import { formatMoney, formatPercent } from "@/lib/format"
import { createClient } from "@/lib/supabase/server"
import { getCanonicalMetric } from "@/services/metrics/canonical"
import type { Alert, AlertStatus } from "@/types/database"

import { isChangeOperator } from "./contracts"

/**
 * Reading and acknowledging alerts.
 *
 * Session-scoped throughout, so RLS decides visibility. Any member may
 * acknowledge one: the people who see an alert are the people who deal with
 * it, and routing that through an owner means alerts stay open and the open
 * count stops meaning anything.
 */

export type AlertFilter = {
  status?: AlertStatus
  limit?: number
}

export async function listAlerts(
  businessId: string,
  filter: AlertFilter = {}
): Promise<Alert[]> {
  const supabase = await createClient()

  let query = supabase
    .from("alerts")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 50)

  if (filter.status) query = query.eq("status", filter.status)

  const { data, error } = await query

  if (error) {
    console.error("[automation] listAlerts failed", error.message)
    return []
  }

  return data ?? []
}

export async function countOpenAlerts(businessId: string): Promise<number> {
  const supabase = await createClient()

  const { count, error } = await supabase
    .from("alerts")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", "OPEN")

  if (error) {
    console.error("[automation] countOpenAlerts failed", error.message)
    return 0
  }

  return count ?? 0
}

export async function acknowledgeAlert(
  alertId: string
): Promise<{ ok: true; alert: Alert } | { ok: false; error: string }> {
  const supabase = await createClient()

  const { data, error } = await supabase.rpc("alert_acknowledge", {
    p_alert_id: alertId,
  })

  if (error) {
    // P0002 is the function's own "no such open alert" -- which is also what
    // an alert belonging to another business looks like, because RLS hid it.
    // The two are not distinguished here on purpose: telling the caller which
    // one it was would confirm that somebody else's alert exists.
    console.error("[automation] acknowledgeAlert failed", error.message)
    return { ok: false, error: "That alert could not be updated." }
  }

  return { ok: true, alert: data as Alert }
}

/* -------------------------------------------------------------------------- */
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

export type PresentedAlert = {
  alert: Alert
  /** The metric's name in the owner's language, not its internal key. */
  metricLabel: string
  /** The figure that fired, formatted for its kind. */
  value: string
  threshold: string
  /** What the number means, when the figure is one people misread. */
  caveat?: string
}

/**
 * Formats an alert for display.
 *
 * The values arrive as exact decimal strings and are handed STRAIGHT to the
 * formatters, which pass them to `Intl.NumberFormat` without converting. This
 * is the whole point of migration 0011: an alert that rounded its own trigger
 * value while displaying it would be reporting a different number from the one
 * it fired on.
 */
export function presentAlert(alert: Alert, businessCurrency: string): PresentedAlert {
  const metric = getCanonicalMetric(alert.metric)
  // A ledger alert carries its own currency (migration 0041).
  const currency = alert.currency ?? businessCurrency
  const kind = metric?.kind ?? "money"

  const format = (value: string): string => {
    if (kind === "ratio") return formatPercent(value)
    if (kind === "count" || kind === "quantity") return value
    return formatMoney(value, currency)
  }

  // A percentage-change alert's value and threshold are both percentages,
  // whatever the underlying metric is: a 20% fall in revenue is not $20. The
  // operator is stored on the alert (migration 0017) precisely so this is a
  // fact to read rather than something to infer from the alert's wording.
  const isChange = isChangeOperator(alert.operator)

  return {
    alert,
    metricLabel: metric?.label ?? alert.metric,
    value: isChange ? formatPercent(alert.metric_value) : format(alert.metric_value),
    threshold: isChange ? formatPercent(alert.threshold) : format(alert.threshold),
    caveat: metric?.caveat,
  }
}
