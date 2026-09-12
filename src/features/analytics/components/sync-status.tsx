import Link from "next/link"
import { CircleAlert, PauseCircle, Plug, RefreshCw } from "lucide-react"

import { listConnections } from "@/features/integrations/queries"

/**
 * Where these figures came from, and how current they are.
 *
 * A dashboard that shows yesterday's revenue as though it were live is worse
 * than one that admits it. This says how many sources are connected, when the
 * most recent one last brought data in, and whether any of them needs
 * attention -- and never promises a speed, because nothing here can.
 *
 * "Syncing now" reports a job that is actually RUNNING; it is not a spinner
 * that means "we asked".
 */
export async function SyncStatus() {
  const connections = await listConnections()

  if (connections.length === 0) {
    return (
      <Link
        href="/integrations"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Plug className="size-3.5" aria-hidden />
        No connected sources — figures come from imports
      </Link>
    )
  }

  const needsAttention = connections.filter(
    (c) => c.status === "ERROR" || c.status === "REAUTH_REQUIRED" || c.status === "MAPPING_REVIEW_REQUIRED"
  )
  const paused = connections.filter((c) => c.status === "PAUSED")
  const running = connections.filter((c) => c.jobs.some((job) => job.status === "RUNNING"))

  const lastSync = connections
    .map((c) => c.lastSuccessfulSyncAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1)

  return (
    <Link
      href="/integrations"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {needsAttention.length > 0 ? (
        <>
          <CircleAlert className="size-3.5 text-warning-strong" aria-hidden />
          <span className="text-warning-strong">
            {needsAttention.length === 1
              ? "1 source needs attention"
              : `${needsAttention.length} sources need attention`}
          </span>
        </>
      ) : running.length > 0 ? (
        <>
          <RefreshCw className="size-3.5" aria-hidden />
          <span>Syncing now</span>
        </>
      ) : paused.length > 0 ? (
        <>
          <PauseCircle className="size-3.5" aria-hidden />
          <span>
            {paused.length === connections.length
              ? "Syncing paused"
              : `${paused.length} paused`}
          </span>
        </>
      ) : (
        <>
          <Plug className="size-3.5" aria-hidden />
          <span>
            {connections.length === 1 ? "1 source" : `${connections.length} sources`}
          </span>
        </>
      )}

      {lastSync && (
        <span className="hidden sm:inline">
          · last brought data in {new Date(lastSync).toLocaleString()}
        </span>
      )}
    </Link>
  )
}
