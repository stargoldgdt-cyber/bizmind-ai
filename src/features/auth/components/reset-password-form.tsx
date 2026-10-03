"use client"

import Link from "next/link"
import { useActionState } from "react"
import { ArrowRight, Check, Lock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { resetPasswordAction } from "@/features/auth/actions"
import type { AuthFormState } from "@/features/auth/schemas"

import { AuthField } from "./auth-field"
import { AuthHeading } from "./auth-heading"
import { FormError } from "./form-error"

const initialState: AuthFormState = {}

export function ResetPasswordForm() {
  const [state, formAction, isPending] = useActionState(resetPasswordAction, initialState)

  if (state.success) {
    return (
      <div className="space-y-6 text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-success-subtle text-success-strong">
          <Check className="size-7" aria-hidden />
        </div>
        <div className="space-y-2">
          <h2 className="font-heading text-2xl font-semibold">Password updated</h2>
          <p className="text-sm text-muted-foreground">
            Your password has been successfully changed. Sign in with the new one.
          </p>
        </div>
        <Button asChild size="lg" className="h-11 w-full gap-2 rounded-4xl text-sm">
          <Link href="/login">
            Back to sign in
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-6" noValidate>
      <AuthHeading title="Create new password" description="Enter your new password below." />

      <FormError message={state.formError} />

      <AuthField
        id="password"
        name="password"
        label="New password"
        type="password"
        icon={Lock}
        autoComplete="new-password"
        showStrength
        hint="At least 12 characters. A short sentence works well."
        error={state.fieldErrors?.password}
      />

      <AuthField
        id="confirmPassword"
        name="confirmPassword"
        label="Confirm new password"
        type="password"
        icon={Lock}
        autoComplete="new-password"
        error={state.fieldErrors?.confirmPassword}
      />

      <Button
        type="submit"
        size="lg"
        disabled={isPending}
        className="h-11 w-full gap-2 rounded-4xl text-sm"
      >
        {isPending ? "Saving…" : "Update password"}
        {!isPending && <ArrowRight className="size-4" aria-hidden />}
      </Button>
    </form>
  )
}
