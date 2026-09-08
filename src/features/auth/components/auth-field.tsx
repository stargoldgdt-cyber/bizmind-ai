import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * A labelled input with its validation message.
 *
 * The error is wired to the input with `aria-describedby` and
 * `aria-invalid`, so a screen reader announces the problem instead of only
 * showing red text. Colour alone never carries meaning — the message does.
 */
export function AuthField({
  id,
  name,
  label,
  type = "text",
  autoComplete,
  placeholder,
  defaultValue,
  error,
  required = true,
  hint,
}: {
  id: string
  name: string
  label: string
  type?: string
  autoComplete?: string
  placeholder?: string
  defaultValue?: string
  error?: string
  required?: boolean
  hint?: string
}) {
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(" ")

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        defaultValue={defaultValue}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger-strong">
          {error}
        </p>
      )}
    </div>
  )
}
