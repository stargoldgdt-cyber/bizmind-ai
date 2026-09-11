import "server-only"

import { randomUUID } from "node:crypto"

import { runSyncWorker, type WorkerResult } from "./worker"

/**
 * Keeps the sync worker going until the queue is empty or time runs out.
 *
 * The worker takes one page per job per claim, on purpose (see worker.ts). A
 * first import of a 5,000-row sheet is five pages, so something has to keep
 * claiming: this. A job with more pages goes straight back in the queue, so the
 * next round picks it up at once.
 *
 * It stops when a round claims nothing -- the queue is empty, or everything
 * left is waiting for a retry time or for a person -- or when the budget is
 * spent. The budget is checked before each round, so the overrun is at most one
 * page per claimed job, never a whole sheet. Whatever is left is picked up by
 * the next scheduled run.
 */
export async function drainSyncQueue(options: {
  budgetMs: number
  limit?: number
  now?: () => number
}): Promise<WorkerResult & { rounds: number }> {
  const now = options.now ?? Date.now
  const started = now()
  const workerId = `drain-${randomUUID()}`

  const total = {
    claimed: 0,
    succeeded: 0,
    retried: 0,
    rateLimited: 0,
    deadLettered: 0,
    failed: 0,
    rounds: 0,
  }

  while (now() - started < options.budgetMs) {
    const round = await runSyncWorker({ workerId, limit: options.limit ?? 5 })

    total.rounds += 1
    total.claimed += round.claimed
    total.succeeded += round.succeeded
    total.retried += round.retried
    total.rateLimited += round.rateLimited
    total.deadLettered += round.deadLettered
    total.failed += round.failed

    if (round.claimed === 0) break
  }

  return total
}
