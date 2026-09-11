"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  CircleAlert,
  CircleCheck,
  CirclePause,
  Columns3,
  FileSpreadsheet,
  Info,
  KeyRound,
  LoaderCircle,
  Plus,
  TriangleAlert,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { disconnectIntegrationAction } from "@/features/integrations/actions"
import {
  isChannelChoice,
  SheetConnectWizard,
  type SheetPreset,
} from "@/features/integrations/components/sheet-connect-wizard"
import {
  pauseGoogleSheetAction,
  syncGoogleSheetNowAction,
} from "@/features/integrations/google-actions"
import type { GoogleSetup, SheetConnection } from "@/features/integrations/google-queries"
import { getEntity } from "@/services/ingestion/entities"

/**
 * Google Sheets on the Integrations page: connect Google, add a sheet, and see
 * each sheet's state honestly -- what is running, what was written, what was
 * skipped and why.
 *
 * It never promises a speed. Sheets are read when connected and when the owner
 * presses Sync now; automatic updates are a later step, and the page says so.
 */

/** How long the page keeps refreshing itself while a sync runs. */
const AUTO_REFRESH_MS = 4_000
const AUTO_REFRESH_LIMIT_MS = 3 * 60_000

const OUTCOMES: Record<string, { tone: "success" | "danger"; text: string }> = {
  connected: { tone: "success", text: "Google is connected. Now add a sheet." },
  denied: { tone: "danger", text: "Google sign-in was cancelled. Nothing was connected." },
  expired: {
    tone: "danger",
    text: "That sign-in took too long, or was finished in another tab. Try again.",
  },
  forbidden: { tone: "danger", text: "Only an owner or admin can connect Google." },
  failed: { tone: "danger", text: "Google sign-in could not be completed. Try again." },
  not_configured: { tone: "danger", text: "Google Sheets is not set up on this server yet." },
  missing_refresh_token: {
    tone: "danger",
    text: "Google did not grant the lasting access BizMind needs. Try connecting again.",
  },
  scope_not_granted: {
    tone: "danger",
    text: "BizMind needs permission to see the files you choose. Connect again and allow it.",
  },
  rejected: { tone: "danger", text: "Google refused the sign-in. Try again in a moment." },
  unavailable: { tone: "danger", text: "Google could not be reached. Try again in a moment." },
}

const TRIGGER_LABELS: Record<string, string> = {
  INITIAL: "First import",
  AUTOMATIC: "Sheet changed",
  MANUAL: "Sync now",
  RECONCILIATION: "Routine check",
}

const RUN_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  SUCCEEDED: "Done",
  PARTIAL: "Done, some rows skipped",
  RETRYING: "Waiting",
  FAILED: "Failed",
  DEAD_LETTER: "Stopped",
}

const PLURAL: Record<string, string> = {
  ORDERS: "orders",
  PRODUCTS: "products",
  EXPENSES: "expenses",
}

const numberFormat = new Intl.NumberFormat("en-US")
const count = (value: number | null) => (value === null ? "—" : numberFormat.format(value))

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {new Date(iso).toLocaleString()}
    </time>
  )
}

type Props = {
  setup: GoogleSetup
  canManage: boolean
  businessCurrency: string
  sheets: SheetConnection[]
  outcome: string | null
}

export function GoogleSheetsPanel({ setup, canManage, businessCurrency, sheets, outcome }: Props) {
  const router = useRouter()
  const [wizard, setWizard] = useState<{ preset?: SheetPreset } | null>(null)

  const syncing = sheets.some(
    (s) => s.job?.status === "RUNNING" || (s.job?.status === "QUEUED" && !s.job.stalled)
  )

  // While a sync runs, refresh every few seconds -- for a bounded time only, so
  // a tab left open does not poll forever.
  useEffect(() => {
    if (!syncing) return
    const started = Date.now()
    const timer = window.setInterval(() => {
      if (Date.now() - started > AUTO_REFRESH_LIMIT_MS) {
        window.clearInterval(timer)
        return
      }
      router.refresh()
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [syncing, router])

  const notice = outcome ? OUTCOMES[outcome] : undefined
  const picker =
    setup.ready && setup.clientId && setup.projectNumber && setup.pickerApiKey
      ? { clientId: setup.clientId, projectNumber: setup.projectNumber, apiKey: setup.pickerApiKey }
      : null
  const authorized = setup.authorizedAt !== null

  return (
    <section aria-labelledby="google-sheets-heading" className="space-y-4">
      <Card className="shadow-none">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <FileSpreadsheet className="size-5" aria-hidden />
              </span>
              <div>
                <CardTitle id="google-sheets-heading" className="text-base">
                  Google Sheets
                </CardTitle>
                <CardDescription className="max-w-prose-comfortable">
                  Orders, products or expenses kept in a Google Sheet. BizMind reads a sheet when
                  you connect it and whenever you press Sync now. Automatic updates come in a later
                  release.
                </CardDescription>
              </div>
            </div>

            {picker && canManage && authorized && !wizard && (
              <Button className="rounded-4xl" onClick={() => setWizard({})}>
                <Plus className="size-4" aria-hidden />
                Add a sheet
              </Button>
            )}
            {picker && canManage && !authorized && (
              <Button asChild className="rounded-4xl">
                <a href="/api/v1/integrations/google/start">Connect Google</a>
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3 text-sm">
          {notice && (
            <p
              role={notice.tone === "danger" ? "alert" : "status"}
              className={`flex items-start gap-2 rounded-xl border px-4 py-3 ${
                notice.tone === "success"
                  ? "border-success/25 bg-success-subtle text-success-strong"
                  : "border-danger/25 bg-danger-subtle text-danger-strong"
              }`}
            >
              {notice.tone === "success" ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              )}
              <span>{notice.text}</span>
            </p>
          )}

          {!picker ? (
            <p className="text-muted-foreground">
              Google Sheets is not set up on this server yet, so a sheet cannot be connected.
            </p>
          ) : !authorized ? (
            <p className="text-muted-foreground">
              {canManage
                ? "First, connect the Google account that owns your sheets. BizMind asks to see only the files you choose, and never changes them."
                : "Ask an owner or admin of this business to connect Google."}
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
              <span>
                Google connected <When iso={setup.authorizedAt as string} />.
              </span>
              {canManage && (
                <a
                  href="/api/v1/integrations/google/start"
                  className="text-xs font-medium underline-offset-4 hover:underline"
                >
                  Reconnect Google
                </a>
              )}
              {sheets.length === 0 && <span>No sheet is connected yet.</span>}
            </p>
          )}
        </CardContent>
      </Card>

      {wizard && picker && (
        <SheetConnectWizard
          clientId={picker.clientId}
          projectNumber={picker.projectNumber}
          pickerApiKey={picker.apiKey}
          businessCurrency={businessCurrency}
          preset={wizard.preset}
          onClose={() => setWizard(null)}
        />
      )}

      {sheets.map((sheet) => (
        <SheetCard
          key={sheet.accountId}
          sheet={sheet}
          canManage={canManage}
          canReview={picker !== null && authorized}
          onReview={(preset) => setWizard({ preset })}
        />
      ))}
    </section>
  )
}

function presetOf(sheet: SheetConnection): SheetPreset | null {
  if (!sheet.spreadsheetId || sheet.sheetId === null || !sheet.entity) return null
  const dateFormat = sheet.dateFormat
  return {
    spreadsheetId: sheet.spreadsheetId,
    spreadsheetName: sheet.spreadsheetName ?? "Spreadsheet",
    sheetId: sheet.sheetId,
    sheetTitle: sheet.sheetTitle ?? "",
    entity: sheet.entity,
    mapping: sheet.mapping,
    dateFormat:
      dateFormat === "DMY" || dateFormat === "MDY" || dateFormat === "YMD" ? dateFormat : "auto",
    decimalSeparator: sheet.decimalSeparator === "," ? "," : ".",
    channelType: isChannelChoice(sheet.channelType) ? sheet.channelType : null,
  }
}

function StatusChip({ status }: { status: SheetConnection["status"] }) {
  const chip =
    status === "PAUSED"
      ? { label: "Paused", Icon: CirclePause, className: "text-muted-foreground" }
      : status === "REAUTH_REQUIRED"
        ? { label: "Reconnect Google", Icon: KeyRound, className: "border-warning/30 bg-warning-subtle text-warning-strong" }
        : status === "MAPPING_REVIEW_REQUIRED"
          ? { label: "Columns need review", Icon: Columns3, className: "border-warning/30 bg-warning-subtle text-warning-strong" }
          : status === "ERROR"
            ? { label: "Sync failing", Icon: CircleAlert, className: "border-danger/25 bg-danger-subtle text-danger-strong" }
            : { label: "Connected", Icon: CircleCheck, className: "" }

  return (
    <Badge variant="outline" className={`gap-1 ${chip.className}`}>
      <chip.Icon className="size-3" aria-hidden />
      {chip.label}
    </Badge>
  )
}

function SheetCard({
  sheet,
  canManage,
  canReview,
  onReview,
}: {
  sheet: SheetConnection
  canManage: boolean
  canReview: boolean
  onReview: (preset: SheetPreset) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null)

  const title =
    sheet.spreadsheetName && sheet.sheetTitle
      ? `${sheet.spreadsheetName} — ${sheet.sheetTitle}`
      : (sheet.displayName ?? "Google Sheet")
  const entityLabel = sheet.entity ? getEntity(sheet.entity).label : null
  const preset = presetOf(sheet)
  const canSync = sheet.status === "CONNECTED" || sheet.status === "ERROR"
  const job = sheet.job

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) {
    setMessage(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        setMessage({ tone: "danger", text: result.error })
        return
      }
      setMessage({ tone: "info", text: done })
      router.refresh()
    })
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          {entityLabel && <Badge variant="outline">{entityLabel}</Badge>}
          <StatusChip status={sheet.status} />
        </div>
        <CardDescription>
          {sheet.lastSuccessfulSyncAt ? (
            <>
              Last successful sync <When iso={sheet.lastSuccessfulSyncAt} />
            </>
          ) : (
            "Not synced yet"
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {sheet.status === "REAUTH_REQUIRED" && (
          <Attention tone="warning">
            Google access for this business has expired or was removed. Reconnect Google above —
            every sheet waiting for it carries on by itself.
          </Attention>
        )}
        {sheet.status === "MAPPING_REVIEW_REQUIRED" && (
          <Attention tone="warning">
            {sheet.lastError ?? "The sheet's columns have changed."} Choose Change columns to
            confirm them again. Nothing is read until then.
          </Attention>
        )}
        {sheet.status === "PAUSED" && (
          <Attention tone="neutral">Paused. Nothing is read from this sheet until you resume it.</Attention>
        )}
        {sheet.status === "ERROR" && sheet.lastError && (
          <Attention tone="danger">{sheet.lastError}</Attention>
        )}

        {job && (job.status === "RUNNING" || job.status === "QUEUED") && (
          <p className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {job.status === "RUNNING"
              ? "Reading the sheet now…"
              : job.stalled
                ? "Queued, but nothing has picked it up yet. Press Sync now to continue."
                : "Queued to sync."}
          </p>
        )}
        {job?.status === "RETRYING" && sheet.status !== "MAPPING_REVIEW_REQUIRED" && sheet.status !== "REAUTH_REQUIRED" && (
          <Attention tone="neutral">
            Will try again automatically.{job.lastError ? ` Last problem: ${job.lastError}` : ""}
          </Attention>
        )}
        {job?.status === "DEAD_LETTER" && (
          <Attention tone="danger">
            Stopped after a problem retrying cannot fix.{job.lastError ? ` ${job.lastError}` : ""}{" "}
            Fix it, then press Sync now.
          </Attention>
        )}

        {sheet.missingCount > 0 && (
          <Attention tone="info">
            {numberFormat.format(sheet.missingCount)} {sheet.entity ? PLURAL[sheet.entity] : "records"}{" "}
            in BizMind are no longer in this sheet. Nothing was deleted.
          </Attention>
        )}

        {sheet.runs.length > 0 && (
          <div>
            <p className="mb-2 font-medium">Recent syncs</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="text-right">Added</TableHead>
                    <TableHead className="text-right">Updated</TableHead>
                    <TableHead className="text-right">Unchanged</TableHead>
                    <TableHead className="text-right">Skipped</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sheet.runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        <When iso={r.startedAt} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.trigger ? (TRIGGER_LABELS[r.trigger] ?? r.trigger) : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {RUN_LABELS[r.status] ?? r.status}
                        {r.error && (
                          <span className="block text-muted-foreground">{r.error}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{count(r.inserted)}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{count(r.updated)}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{count(r.unchanged)}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{count(r.rejected)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Each line is one read of up to 1,000 sheet rows.
            </p>
          </div>
        )}

        {sheet.issues.length > 0 && (
          <div>
            <p className="mb-2 font-medium">Rows that were skipped or need a look</p>
            <ul className="space-y-1.5">
              {sheet.issues.map((issue, index) => (
                <li
                  key={`${issue.rowNumber}-${index}`}
                  className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-xs"
                >
                  {issue.severity === "ERROR" ? (
                    <CircleAlert className="mt-px size-3.5 shrink-0 text-danger-strong" aria-label="Skipped" />
                  ) : (
                    <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning-strong" aria-label="Warning" />
                  )}
                  <span className="font-mono tabular-nums">Row {issue.rowNumber}</span>
                  <span className="text-muted-foreground">{issue.message}</span>
                </li>
              ))}
            </ul>
            {sheet.issuesTotal > sheet.issues.length && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                The latest {sheet.issues.length} of {numberFormat.format(sheet.issuesTotal)} problems.
              </p>
            )}
          </div>
        )}

        {message && (
          <p
            role={message.tone === "danger" ? "alert" : "status"}
            className={message.tone === "danger" ? "text-danger-strong" : "text-muted-foreground"}
          >
            {message.text}
          </p>
        )}

        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="rounded-4xl"
              disabled={pending || !canSync}
              onClick={() =>
                run(() => syncGoogleSheetNowAction({ accountId: sheet.accountId }), "Sync started.")
              }
            >
              Sync now
            </Button>

            {sheet.status === "PAUSED" ? (
              <Button
                variant="outline"
                size="sm"
                className="rounded-4xl"
                disabled={pending}
                onClick={() =>
                  run(
                    () => pauseGoogleSheetAction({ accountId: sheet.accountId, paused: false }),
                    "Resumed. BizMind is reading the sheet again."
                  )
                }
              >
                Resume
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-4xl"
                disabled={pending}
                onClick={() =>
                  run(
                    () => pauseGoogleSheetAction({ accountId: sheet.accountId, paused: true }),
                    "Paused."
                  )
                }
              >
                Pause
              </Button>
            )}

            {preset && canReview && (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-4xl"
                disabled={pending}
                onClick={() => onReview(preset)}
              >
                Change columns
              </Button>
            )}

            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm" className="rounded-4xl" disabled={pending}>
                  Disconnect
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Disconnect this sheet?</DialogTitle>
                  <DialogDescription>
                    BizMind stops reading {title}. The {sheet.entity ? PLURAL[sheet.entity] : "records"}{" "}
                    already imported stay in BizMind, and you can connect the sheet again later.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline" className="rounded-4xl">
                      Keep it
                    </Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button
                      className="rounded-4xl"
                      onClick={() =>
                        run(
                          () => disconnectIntegrationAction({ accountId: sheet.accountId }),
                          "Disconnected."
                        )
                      }
                    >
                      Disconnect
                    </Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Attention({
  tone,
  children,
}: {
  tone: "warning" | "danger" | "info" | "neutral"
  children: React.ReactNode
}) {
  const style =
    tone === "warning"
      ? { className: "border-warning/30 bg-warning-subtle text-warning-strong", Icon: TriangleAlert }
      : tone === "danger"
        ? { className: "border-danger/25 bg-danger-subtle text-danger-strong", Icon: CircleAlert }
        : tone === "info"
          ? { className: "border-info/25 bg-info-subtle text-info-strong", Icon: Info }
          : { className: "border-border bg-muted text-muted-foreground", Icon: Info }

  return (
    <p className={`flex items-start gap-2 rounded-xl border px-4 py-3 ${style.className}`}>
      <style.Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}
