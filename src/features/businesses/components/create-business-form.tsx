"use client"

import { useActionState } from "react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { AuthField } from "@/features/auth/components/auth-field"
import { FormError } from "@/features/auth/components/form-error"
import { createBusinessAction } from "@/features/businesses/actions"
import {
  SUPPORTED_CURRENCIES,
  type BusinessFormState,
} from "@/features/businesses/schemas"

const initialState: BusinessFormState = {}

export function CreateBusinessForm() {
  const [state, formAction, isPending] = useActionState(
    createBusinessAction,
    initialState
  )

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormError message={state.formError} />

      <AuthField
        id="name"
        name="name"
        label="Business name"
        placeholder="Acme Trading"
        hint="You can change this later."
        error={state.fieldErrors?.name}
      />

      <div className="space-y-2">
        <Label htmlFor="currency">Reporting currency</Label>
        {/*
          A native select rather than a custom component: it is fully
          accessible by default and gives the correct wheel picker on mobile.
        */}
        <select
          id="currency"
          name="currency"
          defaultValue="BDT"
          aria-invalid={state.fieldErrors?.currency ? true : undefined}
          aria-describedby={state.fieldErrors?.currency ? "currency-error" : "currency-hint"}
          className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {SUPPORTED_CURRENCIES.map((currency) => (
            <option key={currency.code} value={currency.code}>
              {currency.label}
            </option>
          ))}
        </select>
        {state.fieldErrors?.currency ? (
          <p id="currency-error" className="text-xs text-danger-strong">
            {state.fieldErrors.currency}
          </p>
        ) : (
          <p id="currency-hint" className="text-xs text-muted-foreground">
            Every figure BizMind reports for this business uses this currency.
          </p>
        )}
      </div>

      <Button
        type="submit"
        size="lg"
        disabled={isPending}
        className="h-11 w-full rounded-4xl text-sm"
      >
        {isPending ? "Creating…" : "Create business"}
      </Button>
    </form>
  )
}
