"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Tags } from "lucide-react"

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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  classifyCodeAction,
  previewClassificationAction,
  type ImpactRow,
} from "@/features/ledger/actions"
import { formatMoney, formatNumber } from "@/lib/format"
import { FINANCIAL_TYPE_LABEL } from "@/services/ledger/display"
import { parseLedgerMonth, monthKeyOf } from "@/services/ledger/period"

/**
 * Classify one unrecognised marketplace code for this business.
 *
 * Opening the dialog first shows exactly what will move -- the code's lines
 * and amounts per account and month -- so the owner confirms with the effect
 * in front of them. Nothing is re-uploaded; the figures change on the next
 * calculation.
 */
export function ClassifyCodeDialog({
  marketplaceCode,
  formatId,
  matchKey,
  categories,
}: {
  marketplaceCode: string
  formatId: string
  matchKey: string
  categories: { code: string; label: string; financialType: string }[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState("")
  const [name, setName] = useState(matchKey.split("|").filter(Boolean).pop() ?? "")
  const [note, setNote] = useState("")
  const [impact, setImpact] = useState<ImpactRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, startLoading] = useTransition()
  const [saving, startSaving] = useTransition()

  const code = { marketplaceCode, formatId, matchKey }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setError(null)
          startLoading(async () => {
            const result = await previewClassificationAction(code)
            if (result.ok) setImpact(result.rows)
            else setError(result.error)
          })
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="rounded-4xl">
          <Tags className="size-4" aria-hidden />
          Classify
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Classify this marketplace code</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs break-all">{matchKey}</span>
            <span className="mt-2 block">
              This applies to your business only, to every file already uploaded and every
              future one. BizMind&apos;s own rules are never overridden, and you can undo it.
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <p className="text-xs font-medium text-muted-foreground">What this will move</p>
          {loading && <p className="mt-1 text-xs text-muted-foreground">Checking your files…</p>}
          {impact && impact.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">No lines in your active files use this code.</p>
          )}
          {impact && impact.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {impact.map((row) => (
                <li key={`${row.marketplace_account_id}-${row.month}`} className="flex justify-between gap-3 text-xs">
                  <span>
                    {row.account_label} · {parseLedgerMonth(monthKeyOf(row.month))?.label ?? row.month} ·{" "}
                    {formatNumber(row.lines)} line{row.lines === 1 ? "" : "s"}
                  </span>
                  <span className="font-mono tabular-nums">{formatMoney(row.amount, row.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="classify-category">What is it?</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="classify-category" className="w-full">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {FINANCIAL_TYPE_LABEL[c.financialType] ?? c.financialType} · {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="classify-name">Name shown in your figures</Label>
            <Input id="classify-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="classify-note">Why (optional, kept in the audit trail)</Label>
            <Input id="classify-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm text-danger-strong">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" className="rounded-4xl" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            className="rounded-4xl"
            disabled={saving || !category || name.trim() === ""}
            onClick={() =>
              startSaving(async () => {
                setError(null)
                const result = await classifyCodeAction({ ...code, category, subcategory: name, note: note || undefined })
                if (!result.ok) {
                  setError(result.error)
                  return
                }
                setOpen(false)
                router.refresh()
              })
            }
          >
            {saving ? "Saving…" : "Classify"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
