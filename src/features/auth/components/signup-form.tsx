"use client"

import Link from "next/link"
import { useActionState } from "react"
import { ArrowRight, Lock, Mail, User } from "lucide-react"

import { Button } from "@/components/ui/button"
import { signUpAction } from "@/features/auth/actions"
import type { AuthFormState } from "@/features/auth/schemas"

import { AuthField } from "./auth-field"
import { AuthHeading } from "./auth-heading"
import { CheckInbox } from "./check-inbox"
import { FormError } from "./form-error"
import { GoogleButton } from "./google-button"
import { ResendButton } from "./resend-button"

const initialState: AuthFormState = {}

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(signUpAction, initialState)

  // When email confirmation is required the account exists but has no session.
  // Replace the form rather than leaving a filled-in one on screen.
  if (state.success) {
    return (
      <CheckInbox
        heading="Check your inbox"
        intro="We've sent a confirmation link to"
        sentTo={state.email}
      >
        {state.email && <ResendButton kind="signup" email={state.email} cooldown label="Resend email" />}
      </CheckInbox>
    )
  }

  return (
    <div className="space-y-6">
      <AuthHeading title="Create your account" description="Start connecting your business. No credit card needed." />

      <GoogleButton />

      <form action={formAction} className="space-y-5" noValidate>
        <FormError message={state.formError} />

        <AuthField
          id="fullName"
          name="fullName"
          label="Full name"
          icon={User}
          autoComplete="name"
          placeholder="Your full name"
          defaultValue={state.values?.fullName}
          error={state.fieldErrors?.fullName}
        />

        <AuthField
          id="email"
          name="email"
          label="Work email"
          type="email"
          icon={Mail}
          autoComplete="email"
          placeholder="you@company.com"
          defaultValue={state.values?.email}
          error={state.fieldErrors?.email}
        />

        <AuthField
          id="password"
          name="password"
          label="Password"
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
          label="Confirm password"
          type="password"
          icon={Lock}
          autoComplete="new-password"
          error={state.fieldErrors?.confirmPassword}
        />

        <div className="space-y-2">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="terms"
              required
              aria-invalid={state.fieldErrors?.terms ? true : undefined}
              aria-describedby={state.fieldErrors?.terms ? "terms-error" : undefined}
              className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary"
            />
            <span>
              I agree to the{" "}
              <Link href="/terms" className="font-medium text-primary hover:underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="font-medium text-primary hover:underline">
                Privacy Policy
              </Link>
            </span>
          </label>
          {state.fieldErrors?.terms && (
            <p id="terms-error" className="text-xs text-danger-strong">
              {state.fieldErrors.terms}
            </p>
          )}
        </div>

        <Button
          type="submit"
          size="lg"
          disabled={isPending}
          className="h-11 w-full gap-2 rounded-4xl text-sm"
        >
          {isPending ? "Creating your account…" : "Create account"}
          {!isPending && <ArrowRight className="size-4" aria-hidden />}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
