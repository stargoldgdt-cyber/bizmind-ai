import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { ReportKey } from "@/services/reports/catalog"

/** Google Sheets exports and whether Google is connected, through the user's session. */

export type ReportExport = {
  id: string
  report_key: ReportKey
  month_key: string | null
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED"
  spreadsheet_url: string | null
  error: string | null
  created_at: string
}

export async function listRecentExports(businessId: string): Promise<ReportExport[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("report_exports")
    .select("id, report_key, month_key, status, spreadsheet_url, error, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(10)
  if (error) throw new Error(`Could not load the exports: ${error.message}`)
  return (data ?? []) as ReportExport[]
}

export async function getGoogleConnected(businessId: string): Promise<boolean> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("integrations")
    .select("authorized_at")
    .eq("business_id", businessId)
    .eq("provider", "GOOGLE_SHEETS")
    .maybeSingle()
  if (error) throw new Error(`Could not check the Google connection: ${error.message}`)
  return Boolean(data?.authorized_at)
}
