"use client"

import Link from "next/link"
import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { signInAction } from "@/features/auth/actions"
import type { AuthFormState } from "@/features/auth/schemas"

import { AuthField } from "./auth-field"
import { FormError } from "./form-error"

const initialState: AuthFormState = {}

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const [state, formAction, isPending] = useActionState(signInAction, initialState)

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {/* Where to go after signing in. Validated server-side before use, so a
          tampered value cannot turn this into an open redirect. */}
      {redirectTo && <input type="hidden" name="next" value={redirectTo} />}

      <FormError message={state.formError} />

      <AuthField
        id="email"
        name="email"
        label="Email"
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
        autoComplete="current-password"
        error={state.fieldErrors?.password}
      />

      <Button
        type="submit"
        size="lg"
        disabled={isPending}
        className="h-11 w-full rounded-4xl text-sm"
      >
        {isPending ? "Signing in…" : "Sign in"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        New to BizMind?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  )
}
