"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { CircleAlert, CircleCheck, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * Uploading one settlement file.
 *
 * The server does everything that matters -- recognising the format, reading
 * every line, refusing customer data, writing the ledger in one transaction.
 * This component sends the file and says, in words, what happened: recorded,
 * already recorded, or refused and why. It shows no figure it did not receive.
 *
 * A large file is recorded in parts (the database records about 1,000 source
 * rows within its time limit). The server splits it the same way every time and
 * answers each request with how many parts there are, so this sends the same
 * file once per part and adds up what each part reported. If a part fails, the
 * ones before it stay recorded, and sending the same file again skips them.
 */

type Outcome =
  | {
      kind: "recorded"
      sourceFileId: string
      duplicate: boolean
      format: string
      parts: number
      rows: number
      transactions: number
      settlements: number
      payouts: number
      issues: number
      unmapped: number
      errors: number
      warnings: number
    }
  | { kind: "refused"; error: string; problems: string[] }

export function SettlementUploader({
  accounts,
}: {
  accounts: { id: string; label: string; marketplace: string; currency: string }[]
}) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "")
  const [fileName, setFileName] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [progress, setProgress] = useState<{ part: number; parts: number } | null>(null)

  async function upload() {
    const file = fileInput.current?.files?.[0]
    if (!file || !accountId) return

    setPending(true)
    setOutcome(null)
    setProgress(null)

    let recorded = 0
    let parts = 1
    // Set when a whole-file attempt ran out of time: the same file is then sent again, in parts.
    let split = false
    try {
      const total = { rows: 0, transactions: 0, settlements: 0, payouts: 0, issues: 0, unmapped: 0 }
      let allDuplicate = true
      let last: Record<string, unknown> = {}

      for (let part = 0; part < parts; part++) {
        const form = new FormData()
        form.append("file", file)
        form.append("marketplaceAccountId", accountId)
        form.append("part", String(part))
        if (split) form.append("split", "1")

        const response = await fetch("/api/v1/ledger-files", { method: "POST", body: form })
        const body = await response.json()
        if (!response.ok && body.retryInParts && !split && recorded === 0) {
          // Nothing was written (the attempt rolled back). Start again in parts, without asking.
          split = true
          parts = 1
          part = -1
          continue
        }
        if (!response.ok) {
          const earlier =
            recorded > 0
              ? ` Part${recorded === 1 ? "" : "s"} 1${recorded > 1 ? `–${recorded}` : ""} of ${body.parts ?? parts} ${recorded === 1 ? "is" : "are"} recorded. ` +
                "Upload the same file again to carry on: what is already recorded is skipped."
              : ""
          setOutcome({
            kind: "refused",
            error: `${body.error ?? "The file could not be recorded."}${earlier}`,
            problems: body.problems ?? [],
          })
          return
        }

        parts = body.parts ?? 1
        recorded = part + 1
        setProgress({ part: recorded, parts })
        allDuplicate = allDuplicate && body.duplicate
        for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += body[key] ?? 0
        last = body
      }

      setOutcome({
        kind: "recorded",
        sourceFileId: String(last.sourceFileId),
        duplicate: allDuplicate,
        format: String(last.format),
        parts,
        ...total,
        // The same for every part: counted over the whole file.
        errors: Number(last.errors ?? 0),
        warnings: Number(last.warnings ?? 0),
      })
      router.refresh()
    } catch {
      setOutcome({
        kind: "refused",
        error:
          recorded > 0
            ? `The connection dropped after ${recorded} of ${parts} parts. Upload the same file again to carry on: what is already recorded is skipped.`
            : "The upload did not reach BizMind. Check your connection and try again.",
        problems: [],
      })
    } finally {
      setPending(false)
      setProgress(null)
    }
  }

  return (
    <div className="grid gap-5">
      <div className="grid gap-4 rounded-xl border border-border bg-card p-5">
        <div className="grid gap-1.5">
          <Label htmlFor="settlement-account">Marketplace account</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger id="settlement-account" className="w-full sm:w-96">
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.label} · {account.marketplace} · {account.currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="settlement-file">File</Label>
          <Input
            id="settlement-file"
            ref={fileInput}
            type="file"
            accept=".txt,.csv,.xlsx,.pdf"
            className="sm:w-96"
            onChange={(event) => {
              setFileName(event.target.files?.[0]?.name ?? null)
              setOutcome(null)
            }}
          />
          <p className="text-xs text-muted-foreground">
            Amazon: Seller Central → Payments → Reports repository → settlement report, Flat File V2 (.txt).
            <br />
            Amazon (optional): Seller Central → Tax Document Library → a VAT tax invoice or credit note
            (.pdf). Adds the VAT most fees carry that the settlement alone does not itemise.
            <br />
            noon: Finance → Transaction View (item level) and Invoices and Credit Notes (.csv). Upload both
            for each period; the invoices are where noon states the VAT inside its fees.
          </p>
        </div>

        <div>
          <Button className="rounded-4xl" disabled={pending || !fileName || !accountId} onClick={upload}>
            <Upload className="size-4" aria-hidden />
            {pending
              ? progress && progress.parts > 1
                ? `Recording part ${Math.min(progress.part + 1, progress.parts)} of ${progress.parts}…`
                : "Reading and recording…"
              : "Upload and record"}
          </Button>
        </div>
      </div>

      {outcome?.kind === "refused" && (
        <div role="alert" className="flex gap-3 rounded-xl border border-border bg-card px-5 py-4">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-strong" aria-hidden />
          <div className="grid gap-2">
            <p className="text-sm font-medium">Not recorded</p>
            <p className="text-sm text-muted-foreground">{outcome.error}</p>
            {outcome.problems.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {outcome.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {outcome?.kind === "recorded" && (
        <div role="status" className="flex gap-3 rounded-xl border border-border bg-card px-5 py-4">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-strong" aria-hidden />
          <div className="grid gap-2">
            {outcome.duplicate ? (
              <>
                <p className="text-sm font-medium">Already recorded</p>
                <p className="text-sm text-muted-foreground">
                  This exact file is already counting for this account, so nothing was written again.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Recorded: {outcome.format}</p>
                <p className="text-sm text-muted-foreground">
                  {outcome.rows} rows read · {outcome.transactions} ledger lines · {outcome.settlements}{" "}
                  settlement{outcome.settlements === 1 ? "" : "s"} · {outcome.payouts} payout
                  {outcome.payouts === 1 ? "" : "s"}
                </p>
                {outcome.parts > 1 && (
                  <p className="text-sm text-muted-foreground">
                    This is a large file, so it was recorded in {outcome.parts} parts to stay within the
                    database&apos;s time limit. Under Import data it shows as one file, and you can withdraw
                    or put it back as one.
                  </p>
                )}
                {outcome.unmapped > 0 && (
                  <p className="text-sm text-warning-strong">
                    {outcome.unmapped} line{outcome.unmapped === 1 ? " uses" : "s use"} a code BizMind
                    does not recognise yet. They are kept and counted in no total.
                  </p>
                )}
                {outcome.errors > 0 && (
                  <p className="text-sm text-warning-strong">
                    {outcome.errors} row{outcome.errors === 1 ? "" : "s"} could not be read and{" "}
                    {outcome.errors === 1 ? "is" : "are"} listed with the file.
                  </p>
                )}
              </>
            )}
            <div>
              <Button asChild size="sm" variant="outline" className="rounded-4xl">
                {outcome.parts > 1 ? (
                  <Link href="/imports">See the files</Link>
                ) : (
                  <Link href={`/imports/${outcome.sourceFileId}`}>See the file</Link>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
