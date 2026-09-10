import "server-only"

import { getConnector } from "@/services/integrations/contract"
import { callTrusted } from "@/services/integrations/security/privileged"

/**
 * Processing stored webhook deliveries.
 *
 * The receiving path verifies and stores; this path does the work. Separating
 * them is what keeps the endpoint inside a provider's timeout, and it also
 * means a processing bug can be fixed and the stored events replayed, because
 * the raw body was kept.
 *
 * A claimed event was already verified when it was stored. `webhook_claim_events`
 * only returns rows where `signature_valid` is true, so an unverified delivery
 * can never reach a business write no matter what happens here.
 */

export type ProcessResult = {
  claimed: number
  processed: number
  failed: number
  ignored: number
}

type EventRow = {
  id: string
  business_id: string
  integration_account_id: string
  provider: string
  event_type: string
  raw_body: string
  attempts: number
}

export async function processWebhookEvents(limit = 10): Promise<ProcessResult> {
  const result: ProcessResult = { claimed: 0, processed: 0, failed: 0, ignored: 0 }

  const events = await callTrusted<EventRow[]>("webhook_claim_events", {
    p_limit: limit,
  })

  if (!events || events.length === 0) return result
  result.claimed = events.length

  for (const event of events) {
    const connector = getConnector(event.provider)

    if (!connector) {
      await callTrusted("webhook_event_complete", {
        p_event_id: event.id,
        p_status: "FAILED",
        p_error: `No connector registered for ${event.provider}.`,
      })
      result.failed += 1
      continue
    }

    const parsed = connector.parseWebhookRecords({
      eventType: event.event_type,
      rawBody: event.raw_body,
    })

    if (parsed === null || parsed.records.length === 0) {
      // An event we do not act on -- a ping, a topic we do not map. Recorded
      // as processed because there is nothing outstanding about it.
      await callTrusted("webhook_event_complete", {
        p_event_id: event.id,
        p_status: "PROCESSED",
        p_error: null,
      })
      result.ignored += 1
      continue
    }

    try {
      // Through the same trusted, tenant-resolving path the sync worker uses.
      // A webhook is not a privileged shortcut into the data model.
      await callTrusted("webhook_apply_records", {
        p_event_id: event.id,
        p_rows: parsed.records,
      })

      await callTrusted("webhook_event_complete", {
        p_event_id: event.id,
        p_status: "PROCESSED",
        p_error: null,
      })
      result.processed += 1
    } catch (error) {
      await callTrusted("webhook_event_complete", {
        p_event_id: event.id,
        p_status: "FAILED",
        p_error: error instanceof Error ? error.message : "Processing failed.",
      })
      result.failed += 1
    }
  }

  return result
}
