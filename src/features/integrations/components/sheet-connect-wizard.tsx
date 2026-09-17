"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CircleAlert, CircleCheck, FileSpreadsheet, LoaderCircle, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  connectGoogleSheetAction,
  listGoogleTabsAction,
  previewGoogleTabAction,
} from "@/features/integrations/google-actions"
import {
  explainGoogleProblem,
  openSpreadsheetPicker,
  prepareGoogle,
  requestDriveToken,
} from "@/features/integrations/google-picker"
import type { FieldDef, ImportOptions, Mapping, SheetEntityKey } from "@/services/ingestion/contracts"
import { SHEET_ENTITIES, SHEET_ENTITY_LIST } from "@/services/ingestion/entities"
import { suggestMapping } from "@/services/ingestion/mapping"

/**
 * Connecting one tab of a Google Sheet.
 *
 *   1. choose the spreadsheet -- in Google's own picker
 *   2. choose the tab, and what it holds
 *   3. match its columns -- the same fields, warnings and rules as an upload
 *   4. connect -- the first import starts straight away, in the background
 *
 * Every rule the background worker applies on every page is also checked by
 * the server when connecting, so a mistake is shown here rather than parking
 * the sheet a minute later.
 *
 * The Google token this screen uses is short-lived and kept in memory only.
 */

const CHANNELS = [
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

type ChannelChoice = (typeof CHANNELS)[number]

export type SheetPreset = {
  spreadsheetId: string
  spreadsheetName: string
  sheetId: number
  sheetTitle: string
  entity: SheetEntityKey
  mapping: Mapping
  dateFormat: ImportOptions["dateFormat"]
  decimalSeparator: "." | ","
  channelType: ChannelChoice | null
}

type Tab = { sheetId: number; title: string; rowCount: number }
type Step = "pick" | "tab" | "map" | "done"

const PREVIEW_SHOWN = 5

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

export function isChannelChoice(value: string | null): value is ChannelChoice {
  return value !== null && (CHANNELS as readonly string[]).includes(value)
}

function channelLabel(channel: string): string {
  return channel.charAt(0) + channel.slice(1).toLowerCase()
}

export function SheetConnectWizard({
  clientId,
  projectNumber,
  pickerApiKey,
  businessCurrency,
  preset,
  onClose,
}: {
  clientId: string
  projectNumber: string
  pickerApiKey: string
  businessCurrency: string
  /** Present when changing the columns of a sheet that is already connected. */
  preset?: SheetPreset
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const token = useRef<string | null>(null)

  const [googleReady, setGoogleReady] = useState(false)
  const [waiting, setWaiting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<Step>("pick")

  const [spreadsheet, setSpreadsheet] = useState<{ id: string; name: string } | null>(
    preset ? { id: preset.spreadsheetId, name: preset.spreadsheetName } : null
  )
  const [tabs, setTabs] = useState<Tab[]>([])
  const [sheetId, setSheetId] = useState<number | null>(preset?.sheetId ?? null)
  const [tabTitle, setTabTitle] = useState(preset?.sheetTitle ?? "")
  const [entity, setEntity] = useState<SheetEntityKey>(preset?.entity ?? "ORDERS")

  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<Mapping>({})
  const [dropped, setDropped] = useState<string[]>([])
  const [dateFormat, setDateFormat] = useState<ImportOptions["dateFormat"]>(preset?.dateFormat ?? "auto")
  const [decimalSeparator, setDecimalSeparator] = useState<"." | ",">(preset?.decimalSeparator ?? ".")
  const [channelType, setChannelType] = useState<ChannelChoice | "">(preset?.channelType ?? "")
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    let cancelled = false
    prepareGoogle()
      .then(() => {
        if (!cancelled) setGoogleReady(true)
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(explainGoogleProblem(problem))
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Google's sign-in window is a popup, and a browser allows one only straight
   * from a click -- so this runs synchronously from the button, before any await.
   */
  function signInThen(next: (accessToken: string) => Promise<void>) {
    setError(null)
    setWaiting("Waiting for Google…")
    requestDriveToken(clientId)
      .then(async (accessToken) => {
        token.current = accessToken
        await next(accessToken)
      })
      .catch((problem: unknown) => setError(explainGoogleProblem(problem)))
      .finally(() => setWaiting(null))
  }

  async function loadColumns(
    accessToken: string,
    spreadsheetId: string,
    tabId: number,
    forEntity: SheetEntityKey,
    previous?: Mapping
  ) {
    setWaiting("Reading the column headings…")
    const result = await previewGoogleTabAction({ spreadsheetId, sheetId: tabId, accessToken })
    if (!result.ok) {
      setError(result.error)
      return
    }

    setHeaders(result.headers)
    setRows(result.rows)
    setTabTitle(result.tabTitle)

    if (previous) {
      // Keep every choice whose column is still there; name the ones that are not.
      const kept: Mapping = {}
      const gone: string[] = []
      for (const [field, column] of Object.entries(previous)) {
        if (result.headers.includes(column)) kept[field] = column
        else gone.push(column)
      }
      setMapping(kept)
      setDropped(gone)
    } else {
      setMapping(suggestMapping(SHEET_ENTITIES[forEntity], result.headers))
      setDropped([])
    }

    setAcknowledged(false)
    setStep("map")
  }

  function chooseSpreadsheet() {
    signInThen(async (accessToken) => {
      setWaiting("Choose a spreadsheet in Google's window…")
      const picked = await openSpreadsheetPicker({
        token: accessToken,
        apiKey: pickerApiKey,
        appId: projectNumber,
      })
      if (!picked) return

      setWaiting("Reading the spreadsheet…")
      const result = await listGoogleTabsAction({ spreadsheetId: picked.id, accessToken })
      if (!result.ok) {
        setError(result.error)
        return
      }

      setSpreadsheet({ id: picked.id, name: result.title })
      setTabs(result.tabs)
      setSheetId(result.tabs[0]?.sheetId ?? null)
      setStep("tab")
    })
  }

  function readSheetAgain() {
    if (!preset) return
    signInThen((accessToken) =>
      loadColumns(accessToken, preset.spreadsheetId, preset.sheetId, preset.entity, preset.mapping)
    )
  }

  function continueToColumns() {
    const accessToken = token.current
    if (!accessToken || !spreadsheet || sheetId === null) return
    setError(null)
    startTransition(async () => {
      await loadColumns(accessToken, spreadsheet.id, sheetId, entity)
      setWaiting(null)
    })
  }

  function connect() {
    const accessToken = token.current
    if (!accessToken || !spreadsheet || sheetId === null) return
    setError(null)
    startTransition(async () => {
      const result = await connectGoogleSheetAction({
        spreadsheetId: spreadsheet.id,
        sheetId,
        accessToken,
        entity,
        mapping,
        dateFormat,
        decimalSeparator,
        channelType: entity === "ORDERS" && channelType !== "" ? channelType : null,
        acknowledgedWarnings: acknowledged,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setStep("done")
      router.refresh()
    })
  }

  const definition = SHEET_ENTITIES[entity]
  // A synced expense needs a Reference, or an edit would count twice.
  const needed = (field: FieldDef) =>
    field.importance === "required" || (entity === "EXPENSES" && field.key === "external_id")
  const groupOf = (field: FieldDef) => (needed(field) ? "required" : field.importance)

  const missingRequired = definition.fields.filter((f) => needed(f) && !mapping[f.key])
  const missingRecommended = definition.fields.filter(
    (f) => groupOf(f) === "recommended" && !mapping[f.key]
  )
  const channelMissing = entity === "ORDERS" && channelType === ""
  const blocked =
    missingRequired.length > 0 ||
    channelMissing ||
    (missingRecommended.length > 0 && !acknowledged)

  const busy = waiting !== null || pending

  return (
    <Card className="shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              {preset ? "Change the columns BizMind reads" : "Add a Google Sheet"}
            </CardTitle>
            <CardDescription>
              {preset
                ? `${preset.spreadsheetName} — ${preset.sheetTitle}`
                : "One tab holds one kind of record: orders, products or expenses."}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" className="rounded-4xl" onClick={onClose}>
            {step === "done" ? "Close" : "Cancel"}
          </Button>
        </div>
        {!preset && <Stepper current={step} />}
      </CardHeader>

      <CardContent className="space-y-5">
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-subtle px-4 py-3 text-sm text-danger-strong"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        {waiting && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {waiting}
          </p>
        )}

        {step === "pick" && (
          <div className="space-y-3">
            <p className="max-w-prose-comfortable text-sm text-muted-foreground">
              {preset
                ? "BizMind reads the sheet's current headings with a fresh Google sign-in, then shows your column choices again."
                : "Google opens its own file picker. BizMind can read only the spreadsheet you choose there, and never changes it."}
            </p>
            <Button
              className="rounded-4xl"
              disabled={!googleReady || busy}
              onClick={preset ? readSheetAgain : chooseSpreadsheet}
            >
              <FileSpreadsheet className="size-4" aria-hidden />
              {!googleReady
                ? "Loading Google…"
                : preset
                  ? "Read the sheet"
                  : "Choose from Google Drive"}
            </Button>
          </div>
        )}

        {step === "tab" && spreadsheet && (
          <div className="space-y-5">
            <div>
              <p className="text-sm font-medium">{spreadsheet.name}</p>
              <p className="text-xs text-muted-foreground">Which tab should BizMind read?</p>
            </div>

            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Tab</legend>
              {tabs.map((tab) => (
                <label
                  key={tab.sheetId}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 text-sm ${
                    sheetId === tab.sheetId ? "border-primary bg-accent" : "border-border hover:bg-muted"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <input
                      type="radio"
                      name="tab"
                      className="size-4"
                      checked={sheetId === tab.sheetId}
                      onChange={() => setSheetId(tab.sheetId)}
                    />
                    <span className="font-medium">{tab.title}</span>
                  </span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {tab.rowCount.toLocaleString()} rows
                  </span>
                </label>
              ))}
            </fieldset>

            <div>
              <p className="mb-2 text-sm font-medium">What does this tab hold?</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {SHEET_ENTITY_LIST.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setEntity(item.key)}
                    aria-pressed={entity === item.key}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      entity === item.key ? "border-primary bg-accent" : "border-border hover:bg-muted"
                    }`}
                  >
                    <p className="text-sm font-medium">{item.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                  </button>
                ))}
              </div>
            </div>

            <Button
              className="rounded-4xl"
              disabled={sheetId === null || busy}
              onClick={continueToColumns}
            >
              Next: match columns
            </Button>
          </div>
        )}

        {step === "map" && (
          <div className="space-y-5">
            {dropped.length > 0 && (
              <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning-strong">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  These columns are no longer in the sheet: {dropped.join(", ")}. Choose where
                  BizMind should read those figures from now, or leave them out.
                </span>
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="sheet-date-format">Date format</Label>
                <select
                  id="sheet-date-format"
                  className={selectClass}
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value as ImportOptions["dateFormat"])}
                >
                  <option value="auto">Detect (rejects anything ambiguous)</option>
                  <option value="DMY">Day / Month / Year — 31/12/2026</option>
                  <option value="MDY">Month / Day / Year — 12/31/2026</option>
                  <option value="YMD">Year / Month / Day — 2026/12/31</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Only for dates typed as text. Real date cells are read exactly.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sheet-decimal">Decimal separator</Label>
                <select
                  id="sheet-decimal"
                  className={selectClass}
                  value={decimalSeparator}
                  onChange={(e) => setDecimalSeparator(e.target.value as "." | ",")}
                >
                  <option value=".">Point — 1,234.56</option>
                  <option value=",">Comma — 1.234,56</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Only for numbers typed as text. Number cells keep their exact digits.
                </p>
              </div>

              {entity === "ORDERS" && (
                <div className="space-y-2">
                  <Label htmlFor="sheet-channel">Where are these orders from?</Label>
                  <select
                    id="sheet-channel"
                    className={selectClass}
                    value={channelType}
                    onChange={(e) => setChannelType(e.target.value as ChannelChoice | "")}
                  >
                    <option value="">— choose a sales channel —</option>
                    {CHANNELS.map((channel) => (
                      <option key={channel} value={channel}>
                        {channelLabel(channel)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Channel profit depends on it. Keep every row of one order next to each other.
                  </p>
                </div>
              )}
            </div>

            <div>
              <p className="text-sm font-medium">Match your columns — {tabTitle}</p>
              <p className="mt-1 max-w-prose-comfortable text-xs text-muted-foreground">
                Suggested from your headings. Check every one: a column matched to the wrong
                field produces a wrong number that looks right. Figures in {businessCurrency}; a
                row in another currency is skipped, never converted.
              </p>
            </div>

            {(["required", "recommended", "optional"] as const).map((importance) => {
              const fields = definition.fields.filter((f) => groupOf(f) === importance)
              if (fields.length === 0) return null

              return (
                <div key={importance}>
                  <p className="mb-2 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                    {importance === "required"
                      ? "Required"
                      : importance === "recommended"
                        ? "Strongly recommended"
                        : "Optional"}
                  </p>
                  <div className="space-y-2">
                    {fields.map((field) => {
                      const value = mapping[field.key] ?? ""
                      const missing = importance !== "optional" && !value
                      const identityForSync = entity === "EXPENSES" && field.key === "external_id"

                      return (
                        <div
                          key={field.key}
                          className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr] sm:items-center"
                        >
                          <div>
                            <p className="text-sm font-medium">
                              {field.label}
                              {field.scope === "line" && (
                                <Badge variant="outline" className="ml-2">
                                  per line
                                </Badge>
                              )}
                            </p>
                            {identityForSync ? (
                              <p className="text-xs text-muted-foreground">
                                A synced sheet needs a reference for every expense, or editing a
                                row would count it twice.
                              </p>
                            ) : (
                              field.help && (
                                <p className="text-xs text-muted-foreground">{field.help}</p>
                              )
                            )}
                            {missing && field.consequence && !identityForSync && (
                              <p className="mt-1 text-xs text-warning-strong">{field.consequence}</p>
                            )}
                          </div>

                          <select
                            aria-label={`Column for ${field.label}`}
                            className={selectClass}
                            value={value}
                            onChange={(e) => {
                              const next = { ...mapping }
                              if (e.target.value) next[field.key] = e.target.value
                              else delete next[field.key]
                              setMapping(next)
                            }}
                          >
                            <option value="">— not in this sheet —</option>
                            {headers.map((heading) => (
                              <option key={heading} value={heading}>
                                {heading}
                              </option>
                            ))}
                          </select>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            {rows.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">The first rows, as BizMind sees them</p>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {headers.map((heading) => (
                          <TableHead key={heading} className="whitespace-nowrap">
                            {heading}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.slice(0, PREVIEW_SHOWN).map((row, index) => (
                        <TableRow key={index}>
                          {headers.map((heading) => (
                            <TableCell
                              key={heading}
                              className="max-w-64 truncate font-mono text-xs tabular-nums"
                            >
                              {row[heading] ?? ""}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {missingRecommended.length > 0 && (
              <div className="space-y-2 rounded-xl border border-warning/30 p-4">
                <p className="flex items-center gap-2 text-sm font-medium text-warning-strong">
                  <TriangleAlert className="size-4" aria-hidden />
                  Some figures will be incomplete
                </p>
                <ul className="space-y-1 text-sm">
                  {missingRecommended.map((field) => (
                    <li key={field.key}>
                      <span className="font-medium">{field.label}</span> is not chosen.{" "}
                      <span className="text-muted-foreground">{field.consequence}</span>
                    </li>
                  ))}
                </ul>
                <label className="flex cursor-pointer items-start gap-2.5 pt-1 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  <span>
                    I understand these figures will be incomplete, and that profit and margin may
                    be overstated as a result.
                  </span>
                </label>
              </div>
            )}

            {(missingRequired.length > 0 || channelMissing) && (
              <p className="text-sm text-muted-foreground">
                {missingRequired.length > 0
                  ? `Still to choose: ${missingRequired.map((f) => f.label).join(", ")}.`
                  : "Choose which sales channel these orders come from."}
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              <Button className="rounded-4xl" disabled={blocked || busy} onClick={connect}>
                {pending ? "Connecting…" : preset ? "Save and read the sheet" : "Connect and import"}
              </Button>
              {!preset && (
                <Button
                  variant="outline"
                  className="rounded-4xl"
                  disabled={busy}
                  onClick={() => setStep(tabs.length > 0 ? "tab" : "pick")}
                >
                  Back
                </Button>
              )}
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-success-subtle text-success-strong">
              <CircleCheck className="size-5" aria-hidden />
            </span>
            <div>
              <p className="font-medium">
                {preset ? "Saved. BizMind is reading the sheet again." : "Connected. The first import has started."}
              </p>
              <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
                Its progress appears on the sheet&apos;s card below. Rows with a problem are
                skipped and listed there with their row numbers; everything else is imported.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Stepper({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "pick", label: "Choose spreadsheet" },
    { key: "tab", label: "Choose tab" },
    { key: "map", label: "Match columns" },
    { key: "done", label: "Import" },
  ]
  const index = steps.findIndex((s) => s.key === current)

  return (
    <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className={`rounded-4xl px-2.5 py-1 font-medium ${
              i === index
                ? "bg-primary text-primary-foreground"
                : i < index
                  ? "bg-muted text-foreground"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {i + 1}. {s.label}
          </span>
          {i < steps.length - 1 && <span className="text-muted-foreground/50">→</span>}
        </li>
      ))}
    </ol>
  )
}
