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
 */

type Outcome =
  | {
      kind: "recorded"
      sourceFileId: string
      duplicate: boolean
      format: string
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

  async function upload() {
    const file = fileInput.current?.files?.[0]
    if (!file || !accountId) return

    setPending(true)
    setOutcome(null)
    const form = new FormData()
    form.append("file", file)
    form.append("marketplaceAccountId", accountId)

    try {
      const response = await fetch("/api/v1/ledger-files", { method: "POST", body: form })
      const body = await response.json()
      if (!response.ok) {
        setOutcome({ kind: "refused", error: body.error ?? "The file could not be recorded.", problems: body.problems ?? [] })
      } else {
        setOutcome({ kind: "recorded", ...body })
        router.refresh()
      }
    } catch {
      setOutcome({ kind: "refused", error: "The upload did not reach BizMind. Check your connection and try again.", problems: [] })
    } finally {
      setPending(false)
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
          <Label htmlFor="settlement-file">Settlement file</Label>
          <Input
            id="settlement-file"
            ref={fileInput}
            type="file"
            accept=".txt,.csv"
            className="sm:w-96"
            onChange={(event) => {
              setFileName(event.target.files?.[0]?.name ?? null)
              setOutcome(null)
            }}
          />
          <p className="text-xs text-muted-foreground">
            Amazon: Seller Central → Payments → Reports repository → settlement report, Flat File V2 (.txt).
          </p>
        </div>

        <div>
          <Button className="rounded-4xl" disabled={pending || !fileName || !accountId} onClick={upload}>
            <Upload className="size-4" aria-hidden />
            {pending ? "Reading and recording…" : "Upload and record"}
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
                <Link href={`/imports/${outcome.sourceFileId}`}>See the file</Link>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
