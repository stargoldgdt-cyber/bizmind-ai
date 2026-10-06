"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { RotateCcw, Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  restoreLedgerFileAction,
  restoreLedgerFilesAction,
  withdrawLedgerFileAction,
  withdrawLedgerFilesAction,
} from "@/features/imports/ledger-actions"

/**
 * Withdrawing a marketplace settlement file, and putting it back.
 *
 * Simpler than withdrawing an order import: every ledger line belongs to
 * exactly one file, so nothing is ever shared with another source. The
 * confirmation states exactly what stops counting, and that nothing is deleted.
 *
 * A file recorded in parts (a large settlement) is withdrawn and put back as a
 * whole: pass every part in `sourceFileIds`. One part alone would leave the
 * month half counted.
 */
export function LedgerFilePanel({
  sourceFileIds,
  fileName,
  transactions,
  settlements,
  payouts,
  withdrawnAt,
  withdrawalReason,
}: {
  /** The file, or every part of a file recorded in parts. Only the ones to act on. */
  sourceFileIds: string[]
  fileName: string
  transactions: number
  settlements: number
  payouts: number
  withdrawnAt: string | null
  withdrawalReason: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const parts = sourceFileIds.length

  if (withdrawnAt) {
    return (
      <div className="rounded-xl border border-border bg-muted/40 px-5 py-4">
        <p className="text-sm font-medium">
          Withdrawn from your figures on {new Date(withdrawnAt).toLocaleString()}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Its {transactions} lines, {settlements} settlement{settlements === 1 ? "" : "s"} and{" "}
          {payouts} payout{payouts === 1 ? "" : "s"} count towards nothing. Every row is still here.
          {withdrawalReason && ` Reason given: “${withdrawalReason}”.`}
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger-strong">
            {error}
          </p>
        )}
        <Button
          variant="outline"
          className="mt-4 rounded-4xl"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null)
              const result = parts > 1 ? await restoreLedgerFilesAction(sourceFileIds) : await restoreLedgerFileAction(sourceFileIds[0])
              if (!result.ok) setError(result.error)
              else router.refresh()
            })
          }
        >
          <RotateCcw className="size-4" aria-hidden />
          {pending ? "Putting it back…" : parts > 1 ? `Put all ${parts} parts back` : "Put this file back"}
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      <p className="text-sm font-medium">
        {parts > 1 ? `Withdraw this file (all ${parts} parts) from your figures` : "Withdraw this file from your figures"}
      </p>
      <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
        Use this if the wrong file was uploaded. Its lines stop counting; nothing
        is deleted, and you can put it back.
        {parts > 1 && " This file was recorded in parts, so they are withdrawn together: one part alone would leave the month half counted."}
      </p>

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger-strong">
          {error}
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" className="mt-4 rounded-4xl">
            <Undo2 className="size-4" aria-hidden />
            {parts > 1 ? `Withdraw all ${parts} parts` : "Withdraw this file"}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw “{fileName}”?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-left">
                <p>
                  <span className="font-medium text-foreground">
                    {transactions} line{transactions === 1 ? "" : "s"}, {settlements} settlement
                    {settlements === 1 ? "" : "s"} and {payouts} payout{payouts === 1 ? "" : "s"}
                  </span>{" "}
                  will stop counting towards every figure.
                </p>
                <p>
                  Nothing is deleted: every row, the file&apos;s fingerprint and its
                  row problems stay, and you can put it back at any time.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="ledger-withdraw-reason">Why? (optional, kept in the audit trail)</Label>
            <Input
              id="ledger-withdraw-reason"
              value={reason}
              maxLength={200}
              placeholder="Wrong account, duplicate period…"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" className="rounded-4xl" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              className="rounded-4xl"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setError(null)
                  const result =
                    parts > 1 ? await withdrawLedgerFilesAction(sourceFileIds, reason) : await withdrawLedgerFileAction(sourceFileIds[0], reason)
                  setOpen(false)
                  if (!result.ok) setError(result.error)
                  else router.refresh()
                })
              }
            >
              {pending ? "Withdrawing…" : parts > 1 ? "Yes, withdraw all of it" : "Yes, withdraw it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
