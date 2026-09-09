"use client"

import { useEffect, useState, useTransition } from "react"
import { CheckCircle2, CircleHelp, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  decideColumnMeaningAction,
  resolveColumnMeaningsAction,
  type ColumnMeaning,
} from "@/features/imports/mapping-actions"
import { mappableMetrics } from "@/services/metrics/canonical"

/**
 * "What do these columns mean?"
 *
 * FLEXIBLE SOURCE FIELDS. STANDARD BIZMIND MEANING.
 *
 * The wizard's other card asks which column holds the order date. This one
 * asks something different and more dangerous: what a column MEANS. A heading
 * called "Product Wholesale Price" might be the cost of what sold, or what was
 * spent restocking, or the price charged to trade buyers. Each produces a
 * different profit.
 *
 * So BizMind suggests, says why, and waits. Confirming is a deliberate act by
 * a named person, and it is recorded as one. Nothing here calculates anything.
 */

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-none " +
  "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"

type Props = {
  source: string
  entity: string
  columns: string[]
}

const METRIC_OPTIONS = mappableMetrics()

/** Label for a canonical key, so the owner never sees a snake_case identifier. */
function metricLabel(key: string | null): string {
  if (!key) return ""
  return METRIC_OPTIONS.find((m) => m.key === key)?.label ?? key
}

export function ColumnMeanings({ source, entity, columns }: Props) {
  const [pending, startTransition] = useTransition()
  const [loading, setLoading] = useState(true)
  const [meanings, setMeanings] = useState<ColumnMeaning[]>([])
  const [profileName, setProfileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      const result = await resolveColumnMeaningsAction({ source, entity, columns })
      if (cancelled) return

      if (!result.ok) setError(result.error)
      else {
        setMeanings(result.meanings)
        setProfileName(result.profileName)
        setError(null)
      }
      setLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [source, entity, columns])

  function decide(
    meaning: ColumnMeaning,
    decision: "CONFIRMED" | "REJECTED" | "UNKNOWN",
    metric: string | null
  ) {
    startTransition(async () => {
      const result = await decideColumnMeaningAction({
        source,
        entity,
        fieldKey: meaning.fieldKey,
        sourceLabel: meaning.sourceLabel,
        decision,
        metric: decision === "CONFIRMED" ? metric : null,
      })

      if (!result.ok) {
        setError(result.error)
        return
      }

      setError(null)
      setMeanings((current) =>
        current.map((m) =>
          m.fieldKey === meaning.fieldKey
            ? {
                ...m,
                status: result.status,
                mapsTo: result.mapsTo,
                confirmedAt: new Date().toISOString(),
              }
            : m
        )
      )
    })
  }

  if (loading) {
    return (
      <Card className="shadow-none">
        <CardContent className="px-6 py-8 text-sm text-muted-foreground">
          Reading your column headings…
        </CardContent>
      </Card>
    )
  }

  const undecided = meanings.filter(
    (m) => m.status === "SUGGESTED" || m.status === "PENDING_CONFIRMATION"
  )
  const settled = meanings.filter((m) => !undecided.includes(m))
  const confirmed = settled.filter((m) => m.status === "CONFIRMED")

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>What do these columns mean?</CardTitle>
        <CardDescription>
          {profileName
            ? `Recognised as "${profileName}". Anything already settled is reused — only what is new or unresolved is asked about.`
            : "A column heading is a name, not a definition. BizMind will suggest, but it will not decide: a cost column read as the wrong kind of cost produces a profit figure that looks perfectly reasonable and is wrong."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <p role="alert" className="text-sm text-danger-strong">
            {error}
          </p>
        )}

        {undecided.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every column in this file has been dealt with. Nothing to confirm.
          </p>
        ) : (
          <div className="space-y-2">
            {undecided.map((meaning) => (
              <MeaningRow
                key={meaning.fieldKey}
                meaning={meaning}
                pending={pending}
                onDecide={decide}
              />
            ))}
          </div>
        )}

        {settled.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
            >
              {expanded ? "Hide" : "Show"} {settled.length} column
              {settled.length === 1 ? "" : "s"} already settled
              {confirmed.length > 0 && ` (${confirmed.length} in use)`}
            </button>

            {expanded && (
              <ul className="mt-2 space-y-1.5">
                {settled.map((m) => (
                  <li
                    key={m.fieldKey}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{m.sourceLabel}</span>
                    {m.status === "CONFIRMED" && m.mapsTo ? (
                      <>
                        <span className="text-muted-foreground">→</span>
                        <Badge variant="outline" className="gap-1">
                          <CheckCircle2 className="size-3" aria-hidden />
                          {metricLabel(m.mapsTo)}
                        </Badge>
                      </>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        {m.status === "REJECTED" ? "Not used" : "Meaning not known"}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          A confirmed column is recorded against your name and reused next time.
          Nothing you leave unconfirmed enters a BizMind figure — it is kept
          under its own name and shown as unused.
        </p>
      </CardContent>
    </Card>
  )
}

function MeaningRow({
  meaning,
  pending,
  onDecide,
}: {
  meaning: ColumnMeaning
  pending: boolean
  onDecide: (
    meaning: ColumnMeaning,
    decision: "CONFIRMED" | "REJECTED" | "UNKNOWN",
    metric: string | null
  ) => void
}) {
  const [metric, setMetric] = useState(meaning.candidateMetric ?? "")

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{meaning.sourceLabel}</p>
        {meaning.candidateMetric && (
          <>
            <span className="text-muted-foreground">→</span>
            <Badge variant="outline">{metricLabel(meaning.candidateMetric)}?</Badge>
            {meaning.confidence && (
              <span className="text-xs text-muted-foreground">
                {meaning.confidence} confidence in the name
              </span>
            )}
          </>
        )}
      </div>

      {meaning.reason && (
        <p className="mt-1 text-xs text-muted-foreground">{meaning.reason}</p>
      )}

      {meaning.ambiguityWarning && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-warning-strong">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{meaning.ambiguityWarning}</span>
        </p>
      )}

      {!meaning.candidateMetric && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
          <CircleHelp className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            BizMind does not recognise this heading. Tell it what the column is,
            or leave it out.
          </span>
        </p>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="space-y-1">
          <Label
            htmlFor={`metric-${meaning.fieldKey}`}
            className="text-xs text-muted-foreground"
          >
            This column is
          </Label>
          <select
            id={`metric-${meaning.fieldKey}`}
            className={selectClass}
            value={metric}
            onChange={(event) => setMetric(event.target.value)}
          >
            <option value="">— choose a BizMind figure —</option>
            {METRIC_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-2 sm:pt-5">
          <Button
            size="sm"
            className="rounded-4xl"
            disabled={pending || metric === ""}
            onClick={() => onDecide(meaning, "CONFIRMED", metric)}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-4xl"
            disabled={pending}
            onClick={() => onDecide(meaning, "REJECTED", null)}
          >
            Ignore this column
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-4xl"
            disabled={pending}
            onClick={() => onDecide(meaning, "UNKNOWN", null)}
          >
            I am not sure
          </Button>
        </div>
      </div>
    </div>
  )
}
