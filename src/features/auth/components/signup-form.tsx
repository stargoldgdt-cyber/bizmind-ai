"use client"

import Link from "next/link"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { signUpAction } from "@/features/auth/actions"
import type { AuthFormState } from "@/features/auth/schemas"

import { AuthField } from "./auth-field"
import { FormError, FormSuccess } from "./form-error"

const initialState: AuthFormState = {}

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(signUpAction, initialState)

  // When email confirmation is required the account exists but has no session.
  // Replace the form rather than leaving a filled-in one on screen.
  if (state.success) {
    return (
      <div className="space-y-5">
        <FormSuccess message={state.message} />
        <p className="text-sm text-muted-foreground">
          The link expires after a short time. If it does, sign in and we will
          send a new one.
        </p>
        <Button asChild variant="outline" size="lg" className="h-11 w-full rounded-4xl text-sm">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormError message={state.formError} />

      <AuthField
        id="fullName"
        name="fullName"
        label="Your name"
        autoComplete="name"
        placeholder="Fahad Rahman"
        error={state.fieldErrors?.fullName}
      />

      <AuthField
        id="email"
        name="email"
        label="Work email"
        type="email"
        autoComplete="email"
        placeholder="you@company.com"
        error={state.fieldErrors?.email}
      />

      <AuthField
        id="password"
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters. A short sentence works well."
        error={state.fieldErrors?.password}
      />

      <Button
        type="submit"
        size="lg"
        disabled={isPending}
        className="h-11 w-full rounded-4xl text-sm"
      >
        {isPending ? "Creating your account…" : "Create account"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  )
}
