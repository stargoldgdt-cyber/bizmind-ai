"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Sheet } from "lucide-react"

import { Button } from "@/components/ui/button"
import { requestSheetsExportAction } from "@/features/reports/actions"
import type { ReportKey } from "@/services/reports/catalog"

/** Queues a copy of the report into a new Google Sheet. */
export function SheetsExportButton({ report, month }: { report: ReportKey; month: string | null }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  return (
    <div className="grid gap-1">
      <Button
        size="sm"
        variant="outline"
        className="rounded-4xl"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null)
            const result = await requestSheetsExportAction({ report, month })
            if (!result.ok) setMessage({ tone: "error", text: result.error })
            else {
              setMessage({ tone: "ok", text: "Creating a new Google Sheet. It appears below when ready." })
              router.refresh()
            }
          })
        }
      >
        <Sheet className="size-4" aria-hidden />
        {pending ? "Asking…" : "Google Sheets"}
      </Button>
      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={message.tone === "error" ? "text-[11px] text-danger-strong" : "text-[11px] text-muted-foreground"}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
