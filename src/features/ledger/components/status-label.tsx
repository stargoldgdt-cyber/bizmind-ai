import { CircleAlert, CircleCheck } from "lucide-react"

/** Final or Incomplete, always with an icon as well as colour. */
export function StatusLabel({ status }: { status: "FINAL" | "INCOMPLETE" }) {
  return status === "FINAL" ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success-strong">
      <CircleCheck className="size-3.5" aria-hidden />
      Final
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning-strong">
      <CircleAlert className="size-3.5" aria-hidden />
      Incomplete
    </span>
  )
}
