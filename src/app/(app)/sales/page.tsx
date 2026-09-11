import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { OrderFilters } from "@/features/analytics/components/order-filters"
import { RangeSelector } from "@/features/analytics/components/range-selector"
import { listChannels, listOrders } from "@/features/analytics/queries"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { formatMoney } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import {
  DEFAULT_PERIOD,
  isPeriodKey,
  resolvePeriod,
} from "@/services/analytics"
import type { OrderStatus } from "@/types/database"

export const metadata: Metadata = { title: "Sales" }

const PAGE_SIZE = 50

const ORDER_STATUSES: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "FULFILLED",
  "CANCELLED",
  "REFUNDED",
]

function isOrderStatus(value: string | undefined): value is OrderStatus {
  return value !== undefined && (ORDER_STATUSES as string[]).includes(value)
}

/**
 * Sales.
 *
 * Order-level visibility: the screen an owner opens when a figure on the
 * dashboard surprised them and they want to see the rows behind it.
 *
 * FILTERED AND PAGED IN THE DATABASE.
 * Every filter is part of the query and results are capped at 50 a page, so
 * this costs the same for a business in its fifth year as its first month.
 * Nothing is filtered in the browser.
 *
 * NO ARITHMETIC. The table shows stored values — order total and fee — exactly
 * as recorded. It deliberately does NOT show a per-order profit column: that
 * would require allocating costs per line here, in React, which is precisely
 * the arithmetic this product forbids outside SQL. Profit lives on the
 * dashboard, where the analytics engine computes it.
 */
export default async function SalesPage(props: PageProps<"/sales">) {
  const searchParams = await props.searchParams

  const one = (key: string): string | undefined => {
    const value = searchParams[key]
    return Array.isArray(value) ? value[0] : value
  }

  const period = resolvePeriod(
    isPeriodKey(one("range")) ? (one("range") as never) : DEFAULT_PERIOD
  )

  const statusParam = one("status")
  const channelParam = one("channel")
  const search = one("q")?.slice(0, 60)
  const page = Math.max(1, Number.parseInt(one("page") ?? "1", 10) || 1)

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user!.id)
    .maybeSingle()

  const [channels, orders] = await Promise.all([
    listChannels(activeBusiness.id),
    listOrders({
      businessId: activeBusiness.id,
      from: period.from,
      to: period.to,
      status: isOrderStatus(statusParam) ? statusParam : undefined,
      channelId: channelParam,
      search,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }).catch(() => null),
  ])

  const currency = activeBusiness.currency
  const totalPages = orders
    ? Math.max(1, Math.ceil(orders.matchedCount / PAGE_SIZE))
    : 1

  const pageLink = (target: number): string => {
    const params = new URLSearchParams()
    params.set("range", period.key)
    if (statusParam) params.set("status", statusParam)
    if (channelParam) params.set("channel", channelParam)
    if (search) params.set("q", search)
    if (target > 1) params.set("page", String(target))
    return `/sales?${params.toString()}`
  }

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Sales</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {period.label} · figures in {currency}
              {orders && ` · ${orders.matchedCount.toLocaleString()} orders`}
            </p>
          </div>
          <RangeSelector active={period.key} basePath="/sales" />
        </div>

        <div className="mt-6">
          <OrderFilters
            channels={channels}
            statuses={ORDER_STATUSES}
            range={period.key}
            activeStatus={statusParam}
            activeChannel={channelParam}
            activeSearch={search}
          />
        </div>

        {orders === null ? (
          <div
            role="alert"
            className="mt-6 rounded-xl border border-danger/25 bg-danger-subtle px-5 py-6"
          >
            <p className="text-sm font-medium text-danger-strong">
              We couldn&apos;t load your sales.
            </p>
            <p className="mt-1 text-sm text-danger-strong/85">
              Nothing is wrong with your data — the request failed. Try again in
              a moment.
            </p>
            <Button asChild size="sm" variant="outline" className="mt-4 rounded-4xl">
              <Link href={pageLink(page)}>Try again</Link>
            </Button>
          </div>
        ) : orders.rows.length === 0 ? (
          <div className="mt-6 rounded-xl border border-border bg-card px-6 py-12 text-center">
            <p className="font-medium">No orders match</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
              {statusParam || channelParam || search
                ? "Nothing in this period matches those filters. Clearing one of them will widen the search."
                : "There are no orders in this period. Try a longer period, or import the export that covers it."}
            </p>

            <div className="mt-5 flex flex-col items-center justify-center gap-2 sm:flex-row">
              {(statusParam || channelParam || search) && (
                <Button asChild variant="outline" className="rounded-4xl">
                  <Link href={`/sales?range=${period.key}`}>Clear filters</Link>
                </Button>
              )}
              <Button asChild variant="ghost" className="rounded-4xl">
                <Link href="/imports/new">Import data</Link>
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Wide table, its own scroll container. The page never scrolls sideways. */}
            <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <Th>Order</Th>
                    <Th>Date</Th>
                    <Th>Channel</Th>
                    <Th>Customer</Th>
                    <Th>Status</Th>
                    <Th align="right">Fees</Th>
                    <Th align="right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {orders.rows.map((order) => (
                    <tr key={order.id} className="border-b border-border last:border-0">
                      <Td className="font-mono text-xs">
                        {order.order_number ?? "—"}
                      </Td>
                      <Td className="whitespace-nowrap text-muted-foreground">
                        {new Date(order.placed_at).toLocaleDateString(undefined, {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </Td>
                      <Td>{order.channel_name ?? <Unknown />}</Td>
                      <Td>{order.customer_name ?? <Unknown />}</Td>
                      <Td>
                        <StatusChip status={order.status} />
                      </Td>
                      <Td align="right" className="font-mono tabular-nums">
                        {/* Never rendered as 0.00 when unknown. */}
                        {order.fee_total === null ? (
                          <Unknown />
                        ) : (
                          formatMoney(order.fee_total, order.currency)
                        )}
                      </Td>
                      <Td align="right" className="font-mono font-medium tabular-nums">
                        {formatMoney(order.total, order.currency)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <nav
                className="mt-4 flex items-center justify-between gap-4"
                aria-label="Pagination"
              >
                <p className="text-sm text-muted-foreground tabular-nums">
                  Page {page} of {totalPages}
                </p>
                <div className="flex gap-2">
                  <Button
                    asChild={page > 1}
                    size="sm"
                    variant="outline"
                    className="rounded-4xl"
                    disabled={page <= 1}
                  >
                    {page > 1 ? <Link href={pageLink(page - 1)}>Previous</Link> : <span>Previous</span>}
                  </Button>
                  <Button
                    asChild={page < totalPages}
                    size="sm"
                    variant="outline"
                    className="rounded-4xl"
                    disabled={page >= totalPages}
                  >
                    {page < totalPages ? <Link href={pageLink(page + 1)}>Next</Link> : <span>Next</span>}
                  </Button>
                </div>
              </nav>
            )}

            <p className="mt-4 text-xs text-muted-foreground">
              Totals and fees are shown exactly as recorded. Profit per order is
              not shown here because it depends on cost allocation, which the
              analytics engine computes — see the dashboard.
            </p>
          </>
        )}
      </div>
    </AppShell>
  )
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode
  align?: "left" | "right"
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-xs font-medium text-muted-foreground ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode
  align?: "left" | "right"
  className?: string
}) {
  return (
    <td className={`px-4 py-3 ${align === "right" ? "text-right" : ""} ${className}`}>
      {children}
    </td>
  )
}

/** An unrecorded value. Never a zero, never a blank cell. */
function Unknown() {
  return <span className="text-muted-foreground">Not recorded</span>
}

function StatusChip({ status }: { status: string }) {
  const tone: Record<string, string> = {
    FULFILLED: "bg-success-subtle text-success-strong",
    CONFIRMED: "bg-info-subtle text-info-strong",
    PENDING: "bg-muted text-muted-foreground",
    CANCELLED: "bg-danger-subtle text-danger-strong",
    REFUNDED: "bg-warning-subtle text-warning-strong",
  }

  const label = status.charAt(0) + status.slice(1).toLowerCase()

  return (
    <span
      className={`inline-flex rounded-4xl px-2 py-0.5 text-[11px] font-medium ${
        tone[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {label}
    </span>
  )
}
