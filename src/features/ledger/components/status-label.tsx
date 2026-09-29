import { CircleAlert, CircleCheck } from "lucide-react"

import { cn } from "cn"

/** Final or Incomplete, always with an icon as well as colour. */
export function StatusLabel({ status }: { status: "FINAL" | "INCOMPLETE" }) {
  const final = status === "FINAL"
  const Icon = final ? CircleCheck : CircleAlert
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
        final ? "bg-success-subtle text-success-strong" : "bg-warning-subtle text-warning-strong"
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {final ? "Final" : "Incomplete"}
    </span>
  )
}
