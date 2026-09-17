import "server-only"

import { decryptCredential } from "@/lib/crypto"
import { googleOAuthConfig, refreshAccessToken } from "@/services/integrations/connectors/google-sheets/oauth"
import { callTrusted } from "@/services/integrations/security/privileged"
import { parseLedgerMonth } from "@/services/ledger/period"
import { isReportKey, reportAbout, reportSheets, REPORT_CATALOG, type Report, type ReportData } from "@/services/reports/catalog"
import { createReportSpreadsheet, fillReportSpreadsheet } from "@/services/reports/google-sheets-export"

/**
 * Report exports to Google Sheets, run by the background worker (GCC Phase 8).
 *
 * A person only requests an export (report_export_request). This worker, with
 * no session, claims it, reads that export's figures through
 * report_export_data (which derives the business from the export itself),
 * creates a NEW spreadsheet in the business's Drive, records it, fills it, and
 * finishes the export. It never writes to any other spreadsheet.
 */

type Claimed = {
  export_id: string
  business_id: string
  business_name: string
  report_key: string
  month_key: string | null
  credentials_encrypted: string | null
  attempts: number
}

type ExportData = { business_name: string; report_key: string; month_key: string | null; data: ReportData }

export type ExportRunResult = { claimed: number; succeeded: number; retried: number; failed: number }

export async function runReportExports(options: { workerId: string; limit?: number }): Promise<ExportRunResult> {
  const result: ExportRunResult = { claimed: 0, succeeded: 0, retried: 0, failed: 0 }
  const claimed = (await callTrusted<Claimed[]>("report_export_claim", {
    p_worker_id: options.workerId,
    p_limit: options.limit ?? 3,
  })) ?? []
  result.claimed = claimed.length

  for (const item of claimed) {
    // A throw part-way is retried; report_export_complete never retries an
    // export that already created its spreadsheet.
    const outcome = await runOne(item).catch(() => ({
      status: "RETRY" as const,
      error: "The export was interrupted.",
    }))
    const status = await callTrusted<string>("report_export_complete", {
      p_export_id: item.export_id,
      p_status: outcome.status,
      p_error: outcome.error ?? null,
    })
    if (status === "SUCCEEDED") result.succeeded += 1
    else if (status === "QUEUED") result.retried += 1
    else result.failed += 1
  }
  return result
}

async function runOne(item: Claimed): Promise<{ status: "SUCCEEDED" | "FAILED" | "RETRY"; error?: string }> {
  if (!isReportKey(item.report_key)) return { status: "FAILED", error: "That report no longer exists." }
  if (!item.credentials_encrypted) {
    return { status: "FAILED", error: "Google is not connected for this business. Reconnect Google and export again." }
  }

  let refreshToken: string | undefined
  try {
    const sealed = JSON.parse(
      decryptCredential(item.credentials_encrypted, { businessId: item.business_id, purpose: "api_credentials" })
    ) as { refresh_token?: unknown }
    refreshToken = typeof sealed.refresh_token === "string" ? sealed.refresh_token : undefined
  } catch {
    return { status: "FAILED", error: "The stored Google authorization could not be read. Reconnect Google." }
  }
  if (!refreshToken) return { status: "FAILED", error: "Google is not connected for this business. Reconnect Google." }

  const config = googleOAuthConfig()
  if (!config) return { status: "FAILED", error: "Google is not configured on this server." }
  const access = await refreshAccessToken(refreshToken, config)
  if (!access.ok) {
    return access.kind === "reauth"
      ? { status: "FAILED", error: "Google access has expired. Reconnect Google and export again." }
      : { status: "RETRY", error: "Google could not be reached." }
  }

  const loaded = await callTrusted<ExportData>("report_export_data", { p_export_id: item.export_id })
  if (!loaded) return { status: "RETRY", error: "The report's figures could not be read." }
  const month = parseLedgerMonth(item.month_key)
  const report: Report = {
    key: item.report_key,
    title: REPORT_CATALOG[item.report_key].title,
    about: reportAbout(item.report_key, loaded.business_name, item.month_key, month?.label ?? null),
    sheets: reportSheets(item.report_key, loaded.data ?? {}),
  }

  const title = `BizMind — ${report.title}${month ? ` — ${month.label}` : ""}`
  const created = await createReportSpreadsheet(access.accessToken, report, title)
  if (created.kind !== "ok") {
    return created.kind === "permanent_error"
      ? { status: "FAILED", error: created.reason }
      : { status: "RETRY", error: created.reason }
  }

  // Recorded BEFORE anything is written into it: the database then knows the
  // one spreadsheet this export may write to, and a retry never makes a second.
  await callTrusted("report_export_attach", {
    p_export_id: item.export_id,
    p_spreadsheet_id: created.body.spreadsheetId,
    p_spreadsheet_url: created.body.spreadsheetUrl,
  })

  const filled = await fillReportSpreadsheet(created.body, access.accessToken, report)
  if (filled.kind !== "ok") {
    return { status: "FAILED", error: `The spreadsheet was created but could not be filled: ${filled.reason}` }
  }
  return { status: "SUCCEEDED" }
}
