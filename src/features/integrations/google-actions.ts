"use server"

import { revalidatePath } from "next/cache"
import { after } from "next/server"
import { z } from "zod"
import { isSheetEntityKey, SHEET_ENTITY_KEYS } from "@/services/ingestion/entities"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient } from "@/lib/supabase/server"
import {
  getSpreadsheet,
  getValues,
  isApiDisabled,
  isSpreadsheetId,
  rowsRange,
  type GoogleFailure,
} from "@/services/integrations/connectors/google-sheets/client"
import {
  displayRecord,
  headingsFrom,
  recordsFrom,
} from "@/services/integrations/connectors/google-sheets/table"
import { drainSyncQueue } from "@/services/integrations/sync/drain"
import { missingRecommended, readSheetSettings } from "@/services/integrations/sync/tabular"

/**
 * Choosing a sheet: listing a spreadsheet's tabs and previewing one.
 *
 * WHOSE TOKEN
 * -----------
 * These run while the owner is choosing, before a connection exists. They use
 * the short-lived access token the owner's BROWSER got from Google for the
 * Picker -- used once, never stored, never logged. The business's stored
 * Google authorisation is not touched: that is used only by the background
 * worker, so no person's request ever depends on it.
 *
 * The token reaches only Google, at fixed hosts, and the spreadsheet id is
 * validated against Google's alphabet first -- there is no URL here an owner
 * could point somewhere else.
 */

const PREVIEW_ROWS = 20

const pickSchema = z.object({
  spreadsheetId: z.string().refine(isSpreadsheetId, "That is not a Google spreadsheet."),
  /** The browser's own short-lived Google token. Bounded, never stored. */
  accessToken: z.string().min(20).max(4096),
})

const previewSchema = pickSchema.extend({
  sheetId: z.number().int().min(0),
})

type Failure = { ok: false; error: string }

function explain(failure: GoogleFailure): string {
  // Google's status and reason code only -- never the token, never a message
  // text. Without it, "API switched off" and "no access" look identical.
  console.error("[google] a Google request failed:", failure.detail ?? failure.kind)

  if (isApiDisabled(failure)) {
    return (
      "Google Sheets is not fully set up on this server: a Google API BizMind needs " +
      "is switched off in its Google Cloud project."
    )
  }
  if (failure.kind === "rate_limited") {
    return "Google is busy right now. Wait a minute and try again."
  }
  if (failure.kind === "retryable_error") {
    return "Google did not respond. Try again in a moment."
  }
  if (failure.code === "REAUTH_REQUIRED") {
    return "Your Google session expired. Choose the spreadsheet again."
  }
  if (failure.code === "ACCESS_DENIED" || failure.code === "SOURCE_GONE") {
    return (
      "BizMind cannot open that spreadsheet. Choose it again, using the same " +
      "Google account you connected."
    )
  }
  return "That spreadsheet could not be opened."
}

async function mayConnect(): Promise<boolean> {
  const business = await getActiveBusiness()
  return business !== null && (business.role === "OWNER" || business.role === "ADMIN")
}

/** The tabs of a spreadsheet the owner just picked. */
export async function listGoogleTabsAction(
  rawInput: unknown
): Promise<
  | { ok: true; title: string; tabs: { sheetId: number; title: string; rowCount: number }[] }
  | Failure
> {
  if (!(await mayConnect())) {
    return { ok: false, error: "Only an owner or admin can connect a spreadsheet." }
  }

  const parsed = pickSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That spreadsheet could not be read." }

  const sheet = await getSpreadsheet(parsed.data.accessToken, parsed.data.spreadsheetId, fetch)
  if (sheet.kind !== "ok") return { ok: false, error: explain(sheet) }

  return {
    ok: true,
    title: sheet.body.title,
    tabs: sheet.body.tabs.map((t) => ({ sheetId: t.sheetId, title: t.title, rowCount: t.rowCount })),
  }
}

/**
 * The headings and first rows of one tab -- what the mapping step needs.
 *
 * Values are returned as the exact text Google sent. Nothing is converted, so
 * the owner sees the same digits BizMind will store.
 */
export async function previewGoogleTabAction(
  rawInput: unknown
): Promise<
  | { ok: true; tabTitle: string; headers: string[]; rows: Record<string, string>[] }
  | Failure
> {
  if (!(await mayConnect())) {
    return { ok: false, error: "Only an owner or admin can connect a spreadsheet." }
  }

  const parsed = previewSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That tab could not be read." }

  const { accessToken, spreadsheetId, sheetId } = parsed.data

  const sheet = await getSpreadsheet(accessToken, spreadsheetId, fetch)
  if (sheet.kind !== "ok") return { ok: false, error: explain(sheet) }

  const tab = sheet.body.tabs.find((t) => t.sheetId === sheetId)
  if (!tab) return { ok: false, error: "That tab no longer exists in the spreadsheet." }

  const values = await getValues(
    accessToken,
    spreadsheetId,
    [rowsRange(tab.title, 1, 1), rowsRange(tab.title, 2, 1 + PREVIEW_ROWS)],
    fetch
  )
  if (values.kind !== "ok") return { ok: false, error: explain(values) }

  const headers = headingsFrom(values.body[0]?.[0] ?? [])
  if (headers.every((heading) => heading === "")) {
    return {
      ok: false,
      error:
        "The first row of this tab has no column headings. Add a heading above " +
        "each column, then choose it again.",
    }
  }

  const { records } = recordsFrom(headers, values.body[1] ?? [], 2)

  return {
    ok: true,
    tabTitle: tab.title,
    headers: headers.filter((heading) => heading !== ""),
    rows: records.map(displayRecord),
  }
}

/* -------------------------------------------------------------------------- */
/* Connecting a tab, and syncing it on request                                */
/* -------------------------------------------------------------------------- */

const CHANNEL_TYPES = [
  "WEBSITE",
  "SHOPIFY",
  "WOOCOMMERCE",
  "AMAZON",
  "DARAZ",
  "EBAY",
  "FACEBOOK",
  "INSTAGRAM",
  "POS",
  "MANUAL",
  "OTHER",
] as const

const connectSchema = previewSchema.extend({
  entity: z.enum(SHEET_ENTITY_KEYS),
  /** BizMind field -> the sheet's own heading. */
  mapping: z.record(z.string().max(64), z.string().max(256)),
  dateFormat: z.enum(["auto", "DMY", "MDY", "YMD"]),
  decimalSeparator: z.enum([".", ","]),
  /** The sales channel an orders tab represents. Not asked for other tabs. */
  channelType: z.enum(CHANNEL_TYPES).nullable(),
  acknowledgedWarnings: z.boolean(),
})

const syncNowSchema = z.object({ accountId: z.string().uuid() })

/** How long the import runs straight after a request, before the schedule takes over. */
const BACKGROUND_SYNC_BUDGET_MS = 50_000

/**
 * Runs the sync worker AFTER the response has been sent, so the owner sees
 * the import begin instead of waiting for it.
 *
 * This is background work -- the case CLAUDE.md allows the worker's privileged
 * path for. Nothing it does is returned to this request, and the worker takes
 * no business id: it claims whatever is due, derives each job's business from
 * the job, and writes only through the functions that resolve their own
 * tenant.
 */
function startBackgroundSync() {
  after(async () => {
    try {
      await drainSyncQueue({ budgetMs: BACKGROUND_SYNC_BUDGET_MS })
    } catch (error) {
      console.error("[google] background sync failed:", error instanceof Error ? error.name : "unknown")
    }
  })
}

/**
 * Connects one tab and starts its first import.
 *
 * Every check the worker will make on every page is made here first, against
 * the sheet as it stands, so a mistake is shown to the owner now instead of
 * parking the sheet a minute later.
 */
export async function connectGoogleSheetAction(
  rawInput: unknown
): Promise<{ ok: true; accountId: string } | Failure> {
  const business = await getActiveBusiness()
  if (!business || (business.role !== "OWNER" && business.role !== "ADMIN")) {
    return { ok: false, error: "Only an owner or admin can connect a spreadsheet." }
  }

  const parsed = connectSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "The connection details are not valid." }
  const input = parsed.data

  if (input.entity === "ORDERS" && !input.channelType) {
    return {
      ok: false,
      error: "Choose which sales channel these orders come from. Channel profit depends on it.",
    }
  }

  const supabase = await createClient()

  // The worker reads the sheet with the business's own Google sign-in, so
  // there must be one. The browser's token lasts about an hour.
  const { data: google } = await supabase
    .from("integrations")
    .select("authorized_at")
    .eq("business_id", business.id)
    .eq("provider", "GOOGLE_SHEETS")
    .maybeSingle()

  if (!google?.authorized_at) {
    return { ok: false, error: "Connect your Google account first, then choose the spreadsheet." }
  }

  const sheet = await getSpreadsheet(input.accessToken, input.spreadsheetId, fetch)
  if (sheet.kind !== "ok") return { ok: false, error: explain(sheet) }

  const tab = sheet.body.tabs.find((t) => t.sheetId === input.sheetId)
  if (!tab) return { ok: false, error: "That tab no longer exists in the spreadsheet." }

  const values = await getValues(
    input.accessToken,
    input.spreadsheetId,
    [rowsRange(tab.title, 1, 1)],
    fetch
  )
  if (values.kind !== "ok") return { ok: false, error: explain(values) }

  const headers = headingsFrom(values.body[0]?.[0] ?? []).filter((heading) => heading !== "")

  const fit = readSheetSettings(
    {
      entity: input.entity,
      mapping: input.mapping,
      date_format: input.dateFormat,
      decimal_separator: input.decimalSeparator,
    },
    headers
  )
  if (!fit.ok) return { ok: false, error: fit.reason }

  const unchosen = missingRecommended(input.entity, fit.settings.mapping)
  if (unchosen.length > 0 && !input.acknowledgedWarnings) {
    return {
      ok: false,
      error:
        `Some recommended columns are not chosen: ${unchosen.map((f) => f.label).join(", ")}. ` +
        `Confirm you understand which figures will be incomplete.`,
    }
  }

  const { data: account, error } = await supabase.rpc("integration_account_connect", {
    p_business_id: business.id,
    p_provider: "GOOGLE_SHEETS",
    p_external_account_id: `${input.spreadsheetId}:${input.sheetId}`,
    p_display_name: `${sheet.body.title} — ${tab.title}`,
    p_channel_type: input.entity === "ORDERS" ? input.channelType : null,
    p_metadata: {
      spreadsheet_id: input.spreadsheetId,
      sheet_id: input.sheetId,
      entity: input.entity,
      mapping: fit.settings.mapping,
      date_format: input.dateFormat,
      decimal_separator: input.decimalSeparator,
      spreadsheet_name: sheet.body.title,
      sheet_title: tab.title,
    },
  })

  if (error || !account) {
    if (error?.message.includes("different BizMind business")) {
      return {
        ok: false,
        error: "That tab is already connected to a different BizMind business. Disconnect it there first.",
      }
    }
    console.error("[google] connecting a sheet failed:", error?.message ?? "no row")
    return { ok: false, error: "The sheet could not be connected. Try again." }
  }

  const { error: queueError } = await supabase.rpc("sync_enqueue", {
    p_account_id: account.id,
    p_resource: input.entity,
    p_mode: "INITIAL",
  })

  if (queueError) {
    console.error("[google] queuing the first import failed:", queueError.message)
    return {
      ok: false,
      error: "The sheet is saved, but its import could not start yet. Use Sync now in a moment.",
    }
  }

  startBackgroundSync()
  revalidatePath("/integrations")

  return { ok: true, accountId: account.id }
}

/** "Sync now": reads the tab again and writes whatever changed. */
export async function syncGoogleSheetNowAction(rawInput: unknown): Promise<{ ok: true } | Failure> {
  const business = await getActiveBusiness()
  if (!business || (business.role !== "OWNER" && business.role !== "ADMIN")) {
    return { ok: false, error: "Only an owner or admin can start a sync." }
  }

  const parsed = syncNowSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That sheet connection could not be found." }

  const supabase = await createClient()

  // RLS scopes this to the caller's businesses; the filters narrow it to this
  // business's Google Sheets connections.
  const { data: account } = await supabase
    .from("integration_accounts")
    .select("id, status, metadata")
    .eq("id", parsed.data.accountId)
    .eq("business_id", business.id)
    .eq("provider", "GOOGLE_SHEETS")
    .maybeSingle()

  if (!account) return { ok: false, error: "That sheet connection could not be found." }

  const blocked: Partial<Record<string, string>> = {
    PAUSED: "This sheet is paused. Resume it to sync.",
    DISCONNECTED: "This sheet has been disconnected.",
    REAUTH_REQUIRED: "Reconnect your Google account first.",
    MAPPING_REVIEW_REQUIRED: "This sheet's columns have changed. Review its column choices first.",
  }
  const reason = blocked[account.status]
  if (reason) return { ok: false, error: reason }

  const metadata = (account.metadata ?? {}) as Record<string, unknown>
  const entity = metadata.entity
  if (!isSheetEntityKey(entity)) {
    return { ok: false, error: "This sheet's column choices are missing. Review the connection." }
  }

  const { error } = await supabase.rpc("sync_enqueue", {
    p_account_id: account.id,
    p_resource: entity,
    p_mode: "INCREMENTAL",
  })

  if (error) {
    console.error("[google] queuing a sync failed:", error.message)
    return { ok: false, error: "The sync could not start. Try again in a moment." }
  }

  startBackgroundSync()
  revalidatePath("/integrations")

  return { ok: true }
}

const pauseSchema = z.object({ accountId: z.string().uuid(), paused: z.boolean() })

/**
 * Pause or resume one tab. Only the owner's choice can do either: the worker
 * may never pause a connection, nor resume one (migration 0020). Resuming
 * reads the sheet again straight away, so nothing edited meanwhile waits.
 */
export async function pauseGoogleSheetAction(rawInput: unknown): Promise<{ ok: true } | Failure> {
  const business = await getActiveBusiness()
  if (!business || (business.role !== "OWNER" && business.role !== "ADMIN")) {
    return { ok: false, error: "Only an owner or admin can pause or resume a sheet." }
  }

  const parsed = pauseSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That sheet connection could not be found." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("integration_account_pause", {
    p_account_id: parsed.data.accountId,
    p_paused: parsed.data.paused,
  })

  if (error) {
    return {
      ok: false,
      error: parsed.data.paused
        ? "The sheet could not be paused."
        : "The sheet could not be resumed. Only a paused sheet can be resumed.",
    }
  }

  revalidatePath("/integrations")

  if (!parsed.data.paused) {
    return syncGoogleSheetNowAction({ accountId: parsed.data.accountId })
  }

  return { ok: true }
}
