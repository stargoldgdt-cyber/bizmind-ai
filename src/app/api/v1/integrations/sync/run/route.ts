import { NextResponse } from "next/server"

import { signaturesMatch } from "@/lib/crypto"
import { callTrusted } from "@/services/integrations/security/privileged"
import { drainSyncQueue } from "@/services/integrations/sync/drain"
import { runReportExports } from "@/services/integrations/sync/report-exports"

/**
 * The scheduled entry point for background sync.
 *
 * Three jobs, in order:
 *   1. The safety net. Google does not promise to deliver every change
 *      notification, so a connected sheet that has been quiet for 15 minutes
 *      is queued for a check. An unchanged sheet costs one small request.
 *   2. Drain the queue: every due page of every due job, until it is empty or
 *      the time budget is spent.
 *   3. Report exports to Google Sheets that people queued (migration 0040).
 *
 * Authentication is the automation route's, for the same reasons: a shared
 * value in `Authorization: Bearer`, compared in constant time, and the route
 * refuses everything while CRON_SECRET is unset. It takes no parameters and
 * cannot be pointed at a business.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
/** Seconds. The drain stops well before this, so a run never ends mid-write. */
export const maxDuration = 60

const DRAIN_BUDGET_MS = 45_000
const RECONCILE_AFTER_MINUTES = 15
const RECONCILE_LIMIT = 50

export async function POST(request: Request) {
  const configured = process.env.CRON_SECRET?.trim()

  if (!configured || configured.length < 16) {
    console.error(
      "[sync] CRON_SECRET is not set, so scheduled sync cannot run. Set it in " +
        "the hosting environment; it must never be public."
    )
    return NextResponse.json({ status: "unavailable" }, { status: 503 })
  }

  const provided = request.headers.get("authorization") ?? ""

  if (!signaturesMatch(`Bearer ${configured}`, provided)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 })
  }

  try {
    const reconciled = await callTrusted<number>("sync_reconcile_due", {
      p_interval_minutes: RECONCILE_AFTER_MINUTES,
      p_limit: RECONCILE_LIMIT,
    })

    const result = await drainSyncQueue({ budgetMs: DRAIN_BUDGET_MS })
    // 3. Report exports to Google Sheets that were queued and not yet done.
    const exports = await runReportExports({ workerId: `cron-${Date.now()}` })

    // Counts only. Nothing here names a business or a sheet -- this response
    // goes into a scheduler's logs, which are not ours.
    return NextResponse.json({ status: "ok", reconciled: reconciled ?? 0, ...result, exports })
  } catch (error) {
    console.error("[sync] scheduled run failed", error instanceof Error ? error.name : "unknown")
    return NextResponse.json({ status: "error" }, { status: 500 })
  }
}

/**
 * Some schedulers issue a GET. Answering it identically means a misconfigured
 * schedule fails loudly on the shared value rather than silently doing nothing.
 */
export const GET = POST
