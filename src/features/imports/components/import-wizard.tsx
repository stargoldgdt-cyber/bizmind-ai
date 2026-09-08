"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { CircleAlert, CircleCheck, TriangleAlert, Upload } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { commitImportAction, previewImportAction } from "@/features/imports/actions"
import type {
  EntityKey,
  ImportOptions,
  Mapping,
  RowIssue,
  ValidationResult,
} from "@/services/ingestion/contracts"
import { ENTITY_LIST, getEntity } from "@/services/ingestion/entities"

/**
 * The import flow.
 *
 * Four deliberate steps: choose what the file contains, confirm how each
 * column maps, look at exactly what will happen, then commit. The preview step
 * is not decoration — it is the difference between importing data and hoping.
 */

type Step = "upload" | "map" | "preview" | "done"

type UploadResponse = {
  batchId: string
  entity: EntityKey
  columns: string[]
  rowCount: number
  truncated: boolean
  totalRowsInFile: number
  maxRows: number
  suggestedMapping: Mapping
  sampleRows: Record<string, unknown>[]
}

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

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

export function ImportWizard({ businessCurrency }: { businessCurrency: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [step, setStep] = useState<Step>("upload")
  const [entity, setEntity] = useState<EntityKey>("ORDERS")
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const [upload, setUpload] = useState<UploadResponse | null>(null)
  const [mapping, setMapping] = useState<Mapping>({})
  const [options, setOptions] = useState<ImportOptions>({
    dateFormat: "auto",
    decimalSeparator: ".",
    source: "MANUAL",
  })
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [summary, setSummary] = useState<Record<string, number> | null>(null)

  const def = getEntity(entity)

  async function handleUpload(file: File) {
    setError(null)
    setUploading(true)

    const body = new FormData()
    body.append("file", file)
    body.append("entity", entity)

    try {
      const response = await fetch("/api/v1/imports", { method: "POST", body })
      const json = await response.json()

      if (!response.ok) {
        setError(json.error ?? "The file could not be read.")
        return
      }

      setUpload(json as UploadResponse)
      setMapping(json.suggestedMapping ?? {})
      setStep("map")
    } catch {
      setError("The upload failed. Check your connection and try again.")
    } finally {
      setUploading(false)
    }
  }

  function handlePreview() {
    if (!upload) return
    setError(null)

    startTransition(async () => {
      const result = await previewImportAction(upload.batchId, mapping, options)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setValidation(result.validation)
      setStep("preview")
    })
  }

  function handleCommit() {
    if (!upload) return
    setError(null)

    startTransition(async () => {
      const result = await commitImportAction(upload.batchId, mapping, {
        ...options,
        acknowledgedWarnings: acknowledged,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSummary(result.summary)
      setStep("done")
      router.refresh()
    })
  }

  return (
    <div className="space-y-5">
      <Stepper current={step} />

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-subtle px-4 py-3 text-sm text-danger-strong"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {step === "upload" && (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>What is in this file?</CardTitle>
            <CardDescription>
              Pick the kind of data, then choose the file. Nothing is imported yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              {ENTITY_LIST.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setEntity(item.key)}
                  aria-pressed={entity === item.key}
                  className={`rounded-xl border p-4 text-left transition-colors ${
                    entity === item.key
                      ? "border-primary bg-accent"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Unlocks: {item.unlocks.join(", ")}
                  </p>
                </button>
              ))}
            </div>

            <Separator />

            <div>
              <Label htmlFor="file">Choose a CSV or Excel file</Label>
              <input
                id="file"
                type="file"
                accept=".csv,.xlsx,.xlsm,text/csv"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleUpload(file)
                }}
                className="mt-2 block w-full cursor-pointer rounded-lg border border-input bg-background text-sm file:mr-3 file:cursor-pointer file:rounded-l-lg file:border-0 file:bg-muted file:px-4 file:py-2 file:text-sm file:font-medium"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                The first row must contain column headings. Up to 8 MB.
              </p>
              {uploading && (
                <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                  <Upload className="size-4 animate-pulse" aria-hidden />
                  Reading the file…
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {step === "map" && upload && (
        <>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>How should we read this file?</CardTitle>
              <CardDescription>
                {upload.rowCount.toLocaleString()} rows read. These settings are never guessed — an ambiguous date or number is
                rejected rather than interpreted.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="dateFormat">Date format</Label>
                <select
                  id="dateFormat"
                  className={selectClass}
                  value={options.dateFormat}
                  onChange={(e) =>
                    setOptions({ ...options, dateFormat: e.target.value as ImportOptions["dateFormat"] })
                  }
                >
                  <option value="auto">Detect (rejects anything ambiguous)</option>
                  <option value="DMY">Day / Month / Year — 31/12/2026</option>
                  <option value="MDY">Month / Day / Year — 12/31/2026</option>
                  <option value="YMD">Year / Month / Day — 2026/12/31</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="decimal">Decimal separator</Label>
                <select
                  id="decimal"
                  className={selectClass}
                  value={options.decimalSeparator}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      decimalSeparator: e.target.value as "." | ",",
                    })
                  }
                >
                  <option value=".">Point — 1,234.56</option>
                  <option value=",">Comma — 1.234,56</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="source">Where is this data from?</Label>
                <select
                  id="source"
                  className={selectClass}
                  value={options.source}
                  onChange={(e) => setOptions({ ...options, source: e.target.value })}
                >
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c.charAt(0) + c.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Used to attribute sales to a channel and to recognise this file if
                  you import it again.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>Match your columns</CardTitle>
              <CardDescription>
                We have suggested matches from your headings. Check every one — a
                column matched to the wrong field produces a wrong number that
                looks right. Figures in {businessCurrency}.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(["required", "recommended", "optional"] as const).map((importance) => {
                const fields = def.fields.filter((f) => f.importance === importance)
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
                              {field.help && (
                                <p className="text-xs text-muted-foreground">{field.help}</p>
                              )}
                              {missing && field.consequence && (
                                <p className="mt-1 text-xs text-warning-strong">
                                  {field.consequence}
                                </p>
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
                              <option value="">— not in this file —</option>
                              {upload.columns.map((c) => (
                                <option key={c} value={c}>
                                  {c}
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
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-3">
            <Button onClick={handlePreview} disabled={pending} className="rounded-4xl">
              {pending ? "Checking every row…" : "Check the file"}
            </Button>
            <Button variant="outline" onClick={() => setStep("upload")} className="rounded-4xl">
              Start over
            </Button>
          </div>
        </>
      )}

      {step === "preview" && validation && upload && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Rows that will import" value={validation.validRowCount.toLocaleString()} tone="good" />
            <Stat
              label="Rows that will be skipped"
              value={validation.failedRowCount.toLocaleString()}
              tone={validation.failedRowCount > 0 ? "bad" : "neutral"}
            />
            <Stat label="Problems found" value={validation.issues.length.toLocaleString()} tone="neutral" />
          </div>

          {validation.missingRecommended.length > 0 && (
            <Card className="border-warning/30 shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-warning-strong">
                  <TriangleAlert className="size-4" aria-hidden />
                  Some figures will be incomplete
                </CardTitle>
                <CardDescription>
                  This import can still go ahead, but you should know what will be
                  missing before it does.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-2">
                  {validation.missingRecommended.map((m) => (
                    <li key={m.field} className="text-sm">
                      <span className="font-medium">{m.label}</span> is not mapped.{" "}
                      <span className="text-muted-foreground">{m.consequence}</span>
                    </li>
                  ))}
                </ul>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="mt-0.5 size-4"
                  />
                  <span>
                    I understand these figures will be incomplete, and that profit
                    and margin may be overstated as a result.
                  </span>
                </label>
              </CardContent>
            </Card>
          )}

          {validation.issues.length > 0 && (
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>What went wrong, row by row</CardTitle>
                <CardDescription>
                  Rows with an error are skipped. Everything else still imports.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <IssueTable issues={validation.issues.slice(0, 50)} />
                {validation.issues.length > 50 && (
                  <p className="px-4 pt-3 text-xs text-muted-foreground">
                    Showing the first 50 of {validation.issues.length} problems.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="shadow-none">
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>
                The first few records exactly as they will be saved.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <div className="overflow-x-auto px-4">
                <pre className="rounded-lg bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(validation.rows.slice(0, 3), null, 2)}
                </pre>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleCommit}
              disabled={
                pending ||
                validation.blocked ||
                (validation.missingRecommended.length > 0 && !acknowledged)
              }
              className="rounded-4xl"
            >
              {pending
                ? "Importing…"
                : `Import ${validation.validRowCount.toLocaleString()} records`}
            </Button>
            <Button variant="outline" onClick={() => setStep("map")} className="rounded-4xl">
              Back to mapping
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            The import is applied in one step. If anything fails, nothing is saved
            and your existing data is untouched.
          </p>
        </>
      )}

      {step === "done" && summary && (
        <Card className="shadow-none">
          <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="flex size-11 items-center justify-center rounded-md bg-success-subtle text-success-strong">
              <CircleCheck className="size-5" aria-hidden />
            </span>
            <p className="font-heading text-lg font-semibold">Import complete</p>
            <ul className="text-sm text-muted-foreground">
              {Object.entries(summary).map(([key, value]) => (
                <li key={key}>
                  {key.replace(/_/g, " ")}: <span className="font-mono tabular-nums">{value}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap justify-center gap-3">
              <Button asChild className="rounded-4xl">
                <a href="/dashboard">See the dashboard</a>
              </Button>
              <Button
                variant="outline"
                className="rounded-4xl"
                onClick={() => {
                  setStep("upload")
                  setUpload(null)
                  setValidation(null)
                  setSummary(null)
                  setMapping({})
                  setAcknowledged(false)
                }}
              >
                Import another file
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Stepper({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "upload", label: "Choose file" },
    { key: "map", label: "Match columns" },
    { key: "preview", label: "Check" },
    { key: "done", label: "Import" },
  ]
  const index = steps.findIndex((s) => s.key === current)

  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className={`rounded-4xl px-2.5 py-1 font-medium ${
              i === index
                ? "bg-primary text-primary-foreground"
                : i < index
                  ? "bg-success-subtle text-success-strong"
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

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: "good" | "bad" | "neutral"
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
          tone === "good" ? "text-success-strong" : tone === "bad" ? "text-danger-strong" : ""
        }`}
      >
        {value}
      </p>
    </div>
  )
}

function IssueTable({ issues }: { issues: RowIssue[] }) {
  return (
    <div className="overflow-x-auto [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Row</TableHead>
            <TableHead className="w-24">Type</TableHead>
            <TableHead>Problem</TableHead>
            <TableHead className="w-40">Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {issues.map((issue, i) => (
            <TableRow key={`${issue.rowNumber}-${issue.field}-${i}`}>
              <TableCell className="font-mono text-xs tabular-nums">{issue.rowNumber}</TableCell>
              <TableCell>
                <span
                  className={`inline-flex items-center gap-1 rounded-4xl px-2 py-0.5 text-[11px] font-medium ${
                    issue.severity === "ERROR"
                      ? "bg-danger-subtle text-danger-strong"
                      : "bg-warning-subtle text-warning-strong"
                  }`}
                >
                  {issue.severity === "ERROR" ? (
                    <CircleAlert className="size-3" aria-hidden />
                  ) : (
                    <TriangleAlert className="size-3" aria-hidden />
                  )}
                  {issue.severity === "ERROR" ? "Skipped" : "Warning"}
                </span>
              </TableCell>
              <TableCell className="text-xs">{issue.message}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {issue.rawValue ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
