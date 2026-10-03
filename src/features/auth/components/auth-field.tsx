"use client"

import { Eye, EyeOff, type LucideIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { passwordStrength } from "../password-strength"

const BAR_TONE = {
  none: "bg-border",
  danger: "bg-danger",
  warning: "bg-warning",
  success: "bg-success",
} as const

/**
 * A labelled input with its validation message.
 *
 * The error is wired to the input with `aria-describedby` and
 * `aria-invalid`, so a screen reader announces the problem instead of only
 * showing red text. Colour alone never carries meaning — the message does.
 *
 * A password field gets a show/hide button. `showStrength` adds a five-bar
 * meter with its word beside it, which is a hint only: the server decides.
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
  icon: Icon,
  showStrength = false,
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
  icon?: LucideIcon
  showStrength?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const [typed, setTyped] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  // React clears an uncontrolled form after each submit; the meter must follow.
  useEffect(() => {
    const form = inputRef.current?.form
    if (!showStrength || !form) return
    const cleared = () => setTyped("")
    form.addEventListener("reset", cleared)
    return () => form.removeEventListener("reset", cleared)
  }, [showStrength])

  const isPassword = type === "password"
  const strength = passwordStrength(typed)

  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(" ")

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        {Icon && (
          <Icon
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
        )}
        <Input
          ref={inputRef}
          id={id}
          name={name}
          type={isPassword && revealed ? "text" : type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          defaultValue={defaultValue}
          required={required}
          onChange={showStrength ? (event) => setTyped(event.target.value) : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`h-11 rounded-xl ${Icon ? "pl-10" : ""} ${isPassword ? "pr-11" : ""}`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((value) => !value)}
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {revealed ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
          </button>
        )}
      </div>

      {showStrength && typed.length > 0 && (
        <div className="flex items-center gap-3" role="status" aria-live="polite">
          <div className="flex flex-1 gap-1.5" aria-hidden>
            {[1, 2, 3, 4, 5].map((bar) => (
              <span
                key={bar}
                className={`h-1.5 flex-1 rounded-full ${bar <= strength.bars ? BAR_TONE[strength.tone] : "bg-border"}`}
              />
            ))}
          </div>
          <span className="text-xs font-medium text-muted-foreground">{strength.label}</span>
        </div>
      )}

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
