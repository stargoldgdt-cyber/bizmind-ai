"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Check, Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { classifyExpenseCategoryAction, retireExpenseRuleAction } from "@/features/expenses/actions"

type Category = { code: string; label: string; cost_class: string; explanation: string }

const GROUPS: { costClass: string; label: string }[] = [
  { costClass: "OPERATING", label: "Reduces net profit" },
  { costClass: "ADVERTISING", label: "Advertising outside the marketplaces" },
  { costClass: "NOT_PROFIT", label: "Not counted in profit" },
]

/** Say once what one of the business's expense category names means. */
export function ClassifyExpenseCategory({
  categoryName,
  categories,
}: {
  categoryName: string
  categories: Category[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const chosen = categories.find((c) => c.code === code)

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={code} onValueChange={setCode}>
          <SelectTrigger className="w-72" aria-label={`Category for ${categoryName}`}>
            <SelectValue placeholder="Choose what this is" />
          </SelectTrigger>
          <SelectContent>
            {GROUPS.map((group) => (
              <SelectGroup key={group.costClass}>
                <SelectLabel>{group.label}</SelectLabel>
                {categories
                  .filter((c) => c.cost_class === group.costClass)
                  .map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.label}
                    </SelectItem>
                  ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          className="rounded-4xl"
          disabled={pending || code === ""}
          onClick={() =>
            startTransition(async () => {
              setError(null)
              const result = await classifyExpenseCategoryAction({ categoryName, categoryCode: code })
              if (!result.ok) setError(result.error)
              else router.refresh()
            })
          }
        >
          <Check className="size-4" aria-hidden />
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      {chosen && <p className="text-[11px] text-muted-foreground">{chosen.explanation}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger-strong">
          {error}
        </p>
      )}
    </div>
  )
}

export function RetireExpenseRuleButton({ ruleId }: { ruleId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="grid justify-items-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="rounded-4xl"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null)
            const result = await retireExpenseRuleAction(ruleId)
            if (!result.ok) setError(result.error)
            else router.refresh()
          })
        }
      >
        <Undo2 className="size-4" aria-hidden />
        {pending ? "Undoing…" : "Undo"}
      </Button>
      {error && (
        <span role="alert" className="text-[11px] text-danger-strong">
          {error}
        </span>
      )}
    </div>
  )
}
