"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { CircleAlert, RotateCcw, Undo2 } from "lucide-react"

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
import type { WithdrawalPreview } from "@/features/imports/queries"
import { restoreImportAction, withdrawImportAction } from "@/features/imports/actions"

/**
 * Withdrawing an import, and putting it back.
 *
 * THE CONFIRMATION SHOWS THE ACTUAL CONSEQUENCE.
 * Not "are you sure?" but "47 orders stop counting, 12 stay because your
 * Amazon sync also wrote them". The figures come from the database, computed
 * with the same rule the withdrawal itself applies, so the dialog cannot
 * promise something different from what happens.
 *
 * WHAT IT DOES NOT CLAIM.
 * A record this import UPDATED keeps the values this import wrote: BizMind
 * holds no earlier version to put back. That is stated here rather than
 * discovered afterwards.
 *
 * Nothing is deleted. The import, its rows and its problems all remain, and
 * Restore brings the records back into the figures.
 */
export function WithdrawPanel({
  batchId,
  preview,
  withdrawnAt,
  withdrawalReason,
}: {
  batchId: string
  preview: WithdrawalPreview | null
  withdrawnAt: string | null
  withdrawalReason: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (withdrawnAt) {
    return (
      <div className="rounded-xl border border-border bg-muted/40 px-5 py-4">
        <p className="text-sm font-medium">
          Withdrawn from your business data on{" "}
          {new Date(withdrawnAt).toLocaleString()}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Its records no longer count towards any figure. The file, its rows and
          its problems are all still here.
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
              const result = await restoreImportAction(batchId)
              if (!result.ok) setError(result.error)
              else router.refresh()
            })
          }
        >
          <RotateCcw className="size-4" aria-hidden />
          {pending ? "Putting it back…" : "Put this data back"}
        </Button>
      </div>
    )
  }

  if (!preview) {
    return (
      <p className="rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
        BizMind could not work out what this import wrote, so it cannot be
        withdrawn safely.
      </p>
    )
  }

  if (!preview.can_withdraw) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 px-5 py-4">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div>
          <p className="text-sm font-medium">This import cannot be withdrawn</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {preview.blocked_reason ??
              "BizMind cannot tell exactly which records this import wrote."}
          </p>
        </div>
      </div>
    )
  }

  const nothingToWithdraw = preview.records_exclusive === 0

  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      <p className="text-sm font-medium">Withdraw this import from your figures</p>
      <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
        Its records stop counting towards revenue, profit and every other
        figure. Nothing is deleted, and you can put it back.
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Figure label="Records it wrote" value={preview.records_written} />
        <Figure label="Would stop counting" value={preview.records_exclusive} emphasis />
        <Figure label="Would stay" value={preview.records_shared} />
        <Figure label="It created" value={preview.records_created} />
      </dl>

      {preview.records_shared > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {preview.records_shared} record
          {preview.records_shared === 1 ? " is" : "s are"} also written by{" "}
          {preview.shared_with.length > 0
            ? preview.shared_with.join(", ")
            : "another source"}
          , so {preview.records_shared === 1 ? "it stays" : "they stay"} exactly as{" "}
          {preview.records_shared === 1 ? "it is" : "they are"}.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger-strong">
          {error}
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" className="mt-4 rounded-4xl" disabled={nothingToWithdraw}>
            <Undo2 className="size-4" aria-hidden />
            Withdraw from business data
          </Button>
        </DialogTrigger>

        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw “{preview.file_name}”?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-left">
                <p>
                  <span className="font-medium text-foreground">
                    {preview.records_exclusive} record
                    {preview.records_exclusive === 1 ? "" : "s"}
                  </span>{" "}
                  will stop counting towards every figure
                  {preview.orders_exclusive > 0 && ` — ${preview.orders_exclusive} order${
                    preview.orders_exclusive === 1 ? "" : "s"
                  }`}
                  {preview.products_exclusive > 0 && `, ${preview.products_exclusive} product${
                    preview.products_exclusive === 1 ? "" : "s"
                  }`}
                  {preview.expenses_exclusive > 0 && `, ${preview.expenses_exclusive} expense${
                    preview.expenses_exclusive === 1 ? "" : "s"
                  }`}
                  .
                </p>

                {preview.records_shared > 0 && (
                  <p>
                    <span className="font-medium text-foreground">
                      {preview.records_shared} will stay
                    </span>{" "}
                    because another source also wrote{" "}
                    {preview.records_shared === 1 ? "it" : "them"}.
                  </p>
                )}

                {preview.records_updated > 0 && (
                  <p>
                    {preview.records_updated} of these records were UPDATED by this
                    import rather than created by it. They keep the values this
                    import wrote — BizMind holds no earlier version to put back.
                  </p>
                )}

                <p>
                  Nothing is deleted: the file, its rows and its problems stay,
                  and you can put the data back at any time.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="withdraw-reason">Why? (optional, kept in the audit trail)</Label>
            <Input
              id="withdraw-reason"
              value={reason}
              maxLength={200}
              placeholder="Wrong file, duplicate import…"
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
                  const result = await withdrawImportAction(batchId, reason)
                  setOpen(false)
                  if (!result.ok) setError(result.error)
                  else router.refresh()
                })
              }
            >
              {pending ? "Withdrawing…" : "Yes, withdraw it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {nothingToWithdraw && (
        <p className="mt-2 text-xs text-muted-foreground">
          Every record this import wrote is also written by another source, so
          withdrawing it would change nothing.
        </p>
      )}
    </div>
  )
}

function Figure({
  label,
  value,
  emphasis = false,
}: {
  label: string
  value: number
  emphasis?: boolean
}) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={`font-mono text-lg tabular-nums ${
          emphasis ? "font-semibold" : "text-muted-foreground"
        }`}
      >
        {value}
      </dd>
    </div>
  )
}
