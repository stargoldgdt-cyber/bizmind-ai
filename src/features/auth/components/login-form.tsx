"use client"

import Link from "next/link"
import { useActionState, type ReactNode } from "react"
import { ArrowRight, Lock, Mail } from "lucide-react"

import { Button } from "@/components/ui/button"
import { siteConfig } from "@/config/site"
import { signInAction } from "@/features/auth/actions"
import type { AuthFormState } from "@/features/auth/schemas"

import { AuthField } from "./auth-field"
import { AuthHeading } from "./auth-heading"
import { FormError } from "./form-error"
import { GoogleButton } from "./google-button"
import { ResendButton } from "./resend-button"

const initialState: AuthFormState = {}

/** `children` are page-level notices (a failed email link, a failed Google attempt). */
export function LoginForm({ redirectTo, children }: { redirectTo?: string; children?: ReactNode }) {
  const [state, formAction, isPending] = useActionState(signInAction, initialState)

  return (
    <div className="space-y-6">
      <AuthHeading title="Welcome back" description={`Sign in to your ${siteConfig.shortName} account.`} />

      {children}

      <GoogleButton redirectTo={redirectTo} />

      <form action={formAction} className="space-y-5" noValidate>
        {/* Where to go after signing in. Validated server-side before use, so a
            tampered value cannot turn this into an open redirect. */}
        {redirectTo && <input type="hidden" name="next" value={redirectTo} />}

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

        <div className="space-y-2">
          <AuthField
            id="password"
            name="password"
            label="Password"
            type="password"
            icon={Lock}
            autoComplete="current-password"
            error={state.fieldErrors?.password}
          />
          <p className="text-right text-sm">
            <Link href="/forgot-password" className="font-medium text-primary hover:underline">
              Forgot password?
            </Link>
          </p>
        </div>

        <Button
          type="submit"
          size="lg"
          disabled={isPending}
          className="h-11 w-full gap-2 rounded-4xl text-sm"
        >
          {isPending ? "Signing in…" : "Sign in"}
          {!isPending && <ArrowRight className="size-4" aria-hidden />}
        </Button>
      </form>

      {state.needsConfirmation && state.email && (
        <ResendButton kind="signup" email={state.email} cooldown={false} label="Send a new confirmation link" />
      )}

      <p className="text-center text-sm text-muted-foreground">
        New to {siteConfig.shortName}?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  )
}
