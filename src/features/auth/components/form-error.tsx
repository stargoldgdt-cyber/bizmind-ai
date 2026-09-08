import { CircleAlert, CircleCheck } from "lucide-react"

/**
 * A form-level message.
 *
 * State is carried by an icon AND text, never by colour alone — that is the
 * rule for every status signal in the product. `role="alert"` makes a screen
 * reader announce it as soon as it appears.
 */
export function FormError({ message }: { message?: string }) {
  if (!message) return null

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger-subtle px-3.5 py-3 text-sm text-danger-strong"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  )
}

export function FormSuccess({ message }: { message?: string }) {
  if (!message) return null

  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-lg border border-success/25 bg-success-subtle px-3.5 py-3 text-sm text-success-strong"
    >
      <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  )
}
