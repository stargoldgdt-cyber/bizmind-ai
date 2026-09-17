"use server"

import { randomUUID } from "node:crypto"

import { revalidatePath } from "next/cache"
import { after } from "next/server"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient } from "@/lib/supabase/server"
import { isPrivilegedAccessConfigured } from "@/services/integrations/security/privileged"
import { runReportExports } from "@/services/integrations/sync/report-exports"
import { REPORT_KEYS } from "@/services/reports/catalog"

/**
 * Asks for a report to be copied into a NEW Google Sheet (GCC Phase 8).
 *
 * The request is recorded through the person's session; the database checks
 * membership, the OWNER/ADMIN role and that Google is connected, and audits
 * it. The background worker then does the export -- straight away after this
 * response, and on the schedule if that run is cut short.
 */

const requestSchema = z.object({
  report: z.enum(REPORT_KEYS),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable(),
})

export async function requestSheetsExportAction(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Choose a report and a month." }

  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }
  if (business.role !== "OWNER" && business.role !== "ADMIN") {
    return { ok: false, error: "Only an owner or admin can export to Google Sheets." }
  }

  const supabase = await createClient()
  const { error } = await supabase.rpc("report_export_request", {
    p_business_id: business.id,
    p_report_key: parsed.data.report,
    p_month_key: parsed.data.month,
  })
  if (error) return { ok: false, error: error.message }

  if (isPrivilegedAccessConfigured()) {
    after(async () => {
      try {
        await runReportExports({ workerId: `request-${randomUUID()}` })
      } catch (failure) {
        console.error("[reports] background export run failed", failure instanceof Error ? failure.message : "unknown")
      }
    })
  }

  revalidatePath("/ledger/reports")
  return { ok: true }
}
