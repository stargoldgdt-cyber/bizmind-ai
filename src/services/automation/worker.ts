import "server-only"

import { callTrusted } from "@/services/integrations/security/privileged"
import type { AutomationRunStatus } from "@/types/database"

/**
 * The automation worker.
 *
 * Asks the database which rules are due, evaluates each one, and reports what
 * happened. It runs on a schedule with nobody signed in.
 *
 * IT NEVER NAMES A TENANT
 * -----------------------
 * There is no `businessId` parameter here and there cannot be one.
 * `automation_claim_due()` answers "which rules are due?" across every
 * business, returning nothing but rule IDs; each rule's tenant is then
 * resolved inside `automation_evaluate_rule()` from the rule row. This is the
 * same shape as the sync worker, and it is why `callTrusted()` can refuse any
 * privileged call carrying a business id outright.
 *
 * NO FIGURE IS COMPARED HERE
 * --------------------------
 * The worker never sees a metric value, a threshold, or a comparison. All of
 * that happens in SQL. This file decides only what to do about the OUTCOME --
 * which is the same division of labour the sync worker has with its
 * connectors, and the reason `npm run test:money-guard` can pass over a file
 * whose entire subject is financial thresholds.
 */

export type AutomationWorkerResult = {
  claimed: number
  fired: number
  notMatched: number
  skipped: number
  failed: number
}

type ClaimRow = { rule_id: string }

type RunRow = {
  id: string
  rule_id: string
  status: AutomationRunStatus
  skipped_reason: string | null
}

/**
 * Runs one batch.
 *
 * Returns counts rather than throwing. A scheduled worker that throws halfway
 * loses the record of everything that did succeed, and the next run has no way
 * to know how far the last one got.
 */
export async function runAutomationWorker(options: {
  limit?: number
} = {}): Promise<AutomationWorkerResult> {
  const result: AutomationWorkerResult = {
    claimed: 0,
    fired: 0,
    notMatched: 0,
    skipped: 0,
    failed: 0,
  }

  const claimed = await callTrusted<ClaimRow[]>("automation_claim_due", {
    p_limit: options.limit ?? 25,
  })

  if (!claimed || claimed.length === 0) return result
  result.claimed = claimed.length

  for (const { rule_id } of claimed) {
    try {
      const run = await callTrusted<RunRow | RunRow[]>(
        "automation_evaluate_rule",
        { p_rule_id: rule_id }
      )

      const status = (Array.isArray(run) ? run[0]?.status : run?.status) ?? null

      if (status === "FIRED") result.fired += 1
      else if (status === "NOT_MATCHED") result.notMatched += 1
      else if (status === "SKIPPED") result.skipped += 1
      else result.failed += 1
    } catch (error) {
      // One rule that cannot be evaluated must not stop the rest. The claim
      // already moved this rule's next_run_at forward, so a rule that fails
      // every time is retried on its own schedule rather than blocking the
      // queue -- and it is visible, because the failure is logged here and the
      // rule's run history will show nothing new.
      result.failed += 1
      console.error(
        `[automation] rule ${rule_id} could not be evaluated:`,
        error instanceof Error ? error.message : "unknown error"
      )
    }
  }

  return result
}
