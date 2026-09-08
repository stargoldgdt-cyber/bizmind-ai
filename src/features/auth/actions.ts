"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { DASHBOARD_ROUTE, LOGIN_ROUTE, safeRedirectPath } from "@/config/routes"
import { createClient } from "@/lib/supabase/server"

import { signInSchema, signUpSchema, type AuthFormState } from "./schemas"

/**
 * Auth server actions.
 *
 * These run only on the server. Passwords are never logged, never stored by
 * us, and never leave this boundary — Supabase Auth handles hashing and
 * storage.
 */

/**
 * Turns a Zod failure into per-field messages for the form.
 */
function fieldErrorsFrom(error: {
  issues: { path: PropertyKey[]; message: string }[]
}): AuthFormState["fieldErrors"] {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "")
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = issue.message
    }
  }
  return fieldErrors
}

export async function signUpAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  })

  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error) }
  }

  const supabase = await createClient()

  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Read by the handle_new_user() trigger to populate profiles.full_name.
      data: { full_name: parsed.data.fullName },
    },
  })

  if (error) {
    return { formError: error.message }
  }

  // When email confirmation is on, Supabase returns a user with no session.
  // Say so plainly rather than redirecting to a page they cannot yet see.
  if (data.user && !data.session) {
    return {
      success: true,
      message:
        "Check your email and click the confirmation link to activate your account.",
    }
  }

  revalidatePath("/", "layout")
  redirect(DASHBOARD_ROUTE)
}

export async function signInAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  })

  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error) }
  }

  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  })

  if (error) {
    // Deliberately vague. Saying "no account with that email" would let
    // someone probe which addresses are registered.
    return { formError: "That email and password combination is not correct." }
  }

  // Only follow a redirect target that points inside this app.
  const requested = safeRedirectPath(formData.get("next")?.toString())

  revalidatePath("/", "layout")
  redirect(requested ?? DASHBOARD_ROUTE)
}

export async function signOutAction() {
  const supabase = await createClient()
  await supabase.auth.signOut()

  revalidatePath("/", "layout")
  redirect(LOGIN_ROUTE)
}
