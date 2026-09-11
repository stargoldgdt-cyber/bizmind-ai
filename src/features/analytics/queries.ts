import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { OrderStatus } from "@/types/database"

/**
 * Small existence and listing queries for the product pages.
 *
 * NOTHING HERE CALCULATES A FINANCIAL FIGURE.
 *
 * These read stored columns and count rows. Every derived number — revenue,
 * margin, profit, coverage — comes from the analytics service, which computes
 * it in SQL. A helper in this file that quietly summed a column would be a
 * second, unverified definition of a figure the product already defines once.
 *
 * All of them use the session-scoped client, so Row Level Security decides
 * what is visible. The `businessId` argument narrows a query; it does not
 * grant anything.
 */

/**
 * Has this business ever recorded an order, in any period?
 *
 * The dashboard needs this to tell two silences apart: a new business with
 * nothing imported, and an established one whose selected fortnight happened
 * to be quiet. They look identical on screen and deserve opposite advice.
 *
 * `head: true` fetches no rows — only the count.
 */
export async function businessHasAnyOrders(businessId: string): Promise<boolean> {
  const supabase = await createClient()

  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .limit(1)

  if (error) {
    // Assume there IS data. Being wrong this way shows an established owner a
    // "no orders in this period" message; being wrong the other way tells them
    // to import data they already have, which reads as the product losing it.
    console.error("[analytics] businessHasAnyOrders failed", error.message)
    return true
  }

  return (count ?? 0) > 0
}

export type OrderRow = {
  id: string
  order_number: string | null
  placed_at: string
  status: string
  channel_name: string | null
  customer_name: string | null
  /** Exact decimal text, straight from the database. Never parsed. */
  total: string
  fee_total: string | null
  currency: string
}

export type OrderQuery = {
  businessId: string
  from: string
  to: string
  /** A real order status, not a free string — the enum is the allowlist. */
  status?: OrderStatus
  channelId?: string
  search?: string
  limit?: number
  offset?: number
}

/**
 * One page of orders.
 *
 * FILTERED AND PAGED IN THE DATABASE, NOT THE BROWSER.
 *
 * A business with 80,000 orders must not ship 80,000 rows to a phone so that
 * JavaScript can hide most of them. Every filter below becomes part of the
 * query, and `limit`/`offset` bound the result — so the page costs the same
 * whether the business is in its first month or its fifth year.
 */
export async function listOrders(
  query: OrderQuery
): Promise<{ rows: OrderRow[]; matchedCount: number }> {
  const supabase = await createClient()

  let request = supabase
    .from("orders")
    .select(
      "id, order_number, placed_at, status, total, fee_total, currency, " +
        "channels(name), customers(full_name)",
      { count: "exact" }
    )
    .eq("business_id", query.businessId)
    .gte("placed_at", query.from)
    .lte("placed_at", query.to)
    .order("placed_at", { ascending: false })
    .range(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 50) - 1)

  if (query.status) request = request.eq("status", query.status)
  if (query.channelId) request = request.eq("channel_id", query.channelId)

  if (query.search) {
    // Escaped, because a comma or parenthesis in the search box would
    // otherwise be read as PostgREST filter syntax rather than as text.
    const term = query.search.replace(/[,()]/g, " ").trim()
    if (term) request = request.ilike("order_number", `%${term}%`)
  }

  const { data, error, count } = await request

  if (error) {
    console.error("[analytics] listOrders failed", error.message)
    throw new Error("Orders could not be loaded.")
  }

  type Joined = {
    id: string
    order_number: string | null
    placed_at: string
    status: string
    total: string
    fee_total: string | null
    currency: string
    channels: { name: string } | { name: string }[] | null
    customers: { full_name: string | null } | { full_name: string | null }[] | null
  }

  const first = <T,>(value: T | T[] | null): T | null =>
    Array.isArray(value) ? (value[0] ?? null) : value

  const rows: OrderRow[] = ((data ?? []) as unknown as Joined[]).map((row) => ({
    id: row.id,
    order_number: row.order_number,
    placed_at: row.placed_at,
    status: row.status,
    total: row.total,
    fee_total: row.fee_total,
    currency: row.currency,
    channel_name: first(row.channels)?.name ?? null,
    customer_name: first(row.customers)?.full_name ?? null,
  }))

  // Deliberately NOT called `total`. In this codebase `total` is an order's
  // money total, and reusing the word for a row count is how a count ends up
  // in an arithmetic expression that reads like currency.
  return { rows, matchedCount: count ?? 0 }
}

/** The channels this business actually uses, for the Sales filter. */
export async function listChannels(
  businessId: string
): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("channels")
    .select("id, name")
    .eq("business_id", businessId)
    .order("name")

  if (error) {
    console.error("[analytics] listChannels failed", error.message)
    return []
  }

  return data ?? []
}
