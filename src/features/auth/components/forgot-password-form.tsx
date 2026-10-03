"use client"

import Link from "next/link"
import { useActionState, type ReactNode } from "react"
import { ArrowLeft, ArrowRight, Mail } from "lucide-react"

import { Button } from "@/components/ui/button"
import { requestPasswordResetAction } from "@/features/auth/actions"
import type { AuthFormState } from "@/features/auth/schemas"

import { AuthField } from "./auth-field"
import { AuthHeading } from "./auth-heading"
import { CheckInbox } from "./check-inbox"
import { FormError } from "./form-error"
import { ResendButton } from "./resend-button"

const initialState: AuthFormState = {}

/** `children` is a page-level notice (a reset link that did not work). */
export function ForgotPasswordForm({ children }: { children?: ReactNode }) {
  const [state, formAction, isPending] = useActionState(requestPasswordResetAction, initialState)

  if (state.success) {
    return (
      <CheckInbox
        heading="Check your inbox"
        intro="We've sent a password reset link to"
        sentTo={state.email}
      >
        {state.email && <ResendButton kind="reset" email={state.email} cooldown label="Resend email" />}
      </CheckInbox>
    )
  }

  return (
    <form action={formAction} className="space-y-6" noValidate>
      <AuthHeading title="Reset your password" description="Enter your email and we will send you a secure reset link." />

      {children}

      <FormError message={state.formError} />

      <AuthField
        id="email"
        name="email"
        label="Email address"
        type="email"
        icon={Mail}
        autoComplete="email"
        placeholder="you@company.com"
        defaultValue={state.values?.email}
        error={state.fieldErrors?.email}
      />

      <Button
        type="submit"
        size="lg"
        disabled={isPending}
        className="h-11 w-full gap-2 rounded-4xl text-sm"
      >
        {isPending ? "Sending…" : "Send reset link"}
        {!isPending && <ArrowRight className="size-4" aria-hidden />}
      </Button>

      <p className="text-center text-sm">
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to sign in
        </Link>
      </p>
    </form>
  )
}
