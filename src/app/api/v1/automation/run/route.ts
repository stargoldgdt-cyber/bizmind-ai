import { NextResponse } from "next/server"

import { signaturesMatch } from "@/lib/crypto"
import { runAutomationWorker } from "@/services/automation/worker"

/**
 * The scheduled entry point for the automation worker.
 *
 * There is no session here and there cannot be: a cron service is not a
 * person. Its authentication is a shared secret in an `Authorization: Bearer`
 * header, which is the convention Vercel Cron already sends.
 *
 * IT FAILS CLOSED
 * ---------------
 * With `CRON_SECRET` unset, this route refuses everything. The tempting
 * alternative -- "no secret configured, so allow it" -- would turn a missing
 * environment variable into an endpoint the whole internet can call, and the
 * mistake would be invisible because everything would appear to work.
 *
 * WHAT AN ATTACKER WOULD GET IF THEY DID GET IN
 * ---------------------------------------------
 * Not much, and that is deliberate. This route takes no parameters, reads no
 * request body, and cannot be pointed at a business. The worst it can do is
 * evaluate rules that were already due, slightly early. It is protected
 * anyway, because "harmless" is not a property to rely on remaining true.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** How many rules one invocation will evaluate. */
const BATCH_LIMIT = 25

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim()

  if (!secret || secret.length < 16) {
    console.error(
      "[automation] CRON_SECRET is not set, so the scheduled worker cannot " +
        "run. Set it in the hosting environment; it must never be public."
    )
    return NextResponse.json({ status: "unavailable" }, { status: 503 })
  }

  const provided = request.headers.get("authorization") ?? ""

  // Constant time. A byte-by-byte comparison that returns early leaks how much
  // of the secret is right, which is enough to recover it one byte at a time.
  if (!signaturesMatch(`Bearer ${secret}`, provided)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 })
  }

  try {
    const result = await runAutomationWorker({ limit: BATCH_LIMIT })

    // Counts only. Nothing here names a business, a rule or a figure -- this
    // response goes into a cron provider's logs, which are not ours.
    return NextResponse.json({ status: "ok", ...result })
  } catch (error) {
    console.error("[automation] worker failed", error)
    return NextResponse.json({ status: "error" }, { status: 500 })
  }
}

/**
 * Some schedulers issue a GET. Answering it identically means a misconfigured
 * schedule fails loudly on the secret rather than silently doing nothing.
 */
export const GET = POST
