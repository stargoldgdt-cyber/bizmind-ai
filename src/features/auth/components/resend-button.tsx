"use client"

import { useActionState, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { requestPasswordResetAction, resendConfirmationAction } from "@/features/auth/actions"
import type { AuthFormState } from "@/features/auth/schemas"

import { FormError } from "./form-error"

const initialState: AuthFormState = {}
const COOLDOWN_SECONDS = 60

/**
 * "Resend email", with a countdown so it cannot be pressed in a rush (the mail
 * service limits how many it will send).
 *
 * `cooldown` is true when an email has only just been sent, which starts the
 * countdown at once, and false when none has (sign-in found an unconfirmed
 * address), where the button is live straight away. Each press restarts it.
 */
export function ResendButton({
  kind,
  email,
  cooldown,
  label,
}: {
  kind: "signup" | "reset"
  email: string
  cooldown: boolean
  label: string
}) {
  const action = kind === "reset" ? requestPasswordResetAction : resendConfirmationAction
  const [state, formAction, isPending] = useActionState(action, initialState)

  // `null` until the first tick: the countdown then runs from the moment the
  // component appeared (when `cooldown`), and from each press after that.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)

  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = setTimeout(() => {
      tick()
      setStartedAt((current) => current ?? (cooldown ? Date.now() : 0))
    }, 0)
    const interval = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(interval)
    }
  }, [cooldown])

  const secondsLeft =
    startedAt === null
      ? cooldown
        ? COOLDOWN_SECONDS
        : 0
      : startedAt === 0
        ? 0
        : Math.max(0, COOLDOWN_SECONDS - Math.max(0, Math.floor((now - startedAt) / 1000)))

  return (
    <form action={formAction} onSubmit={() => setStartedAt(Date.now())} className="space-y-3">
      <input type="hidden" name="email" value={email} />
      <FormError message={state.formError} />
      <Button
        type="submit"
        variant="ghost"
        size="lg"
        disabled={isPending || secondsLeft > 0}
        className="h-10 w-full rounded-4xl text-sm text-muted-foreground"
      >
        {isPending ? "Sending…" : secondsLeft > 0 ? `${label} (${secondsLeft}s)` : label}
      </Button>
      {state.success && secondsLeft > 0 && (
        <p role="status" className="text-center text-xs text-muted-foreground">
          Sent again. It can take a minute to arrive.
        </p>
      )}
    </form>
  )
}
