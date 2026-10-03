"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { DASHBOARD_ROUTE, LOGIN_ROUTE, RESET_PASSWORD_ROUTE, safeRedirectPath } from "@/config/routes"
import { createClient } from "@/lib/supabase/server"

import {
  emailOnlySchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  type AuthFormState,
} from "./schemas"

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

/**
 * What the person typed in the non-secret fields, handed back with an error so
 * the form is not blanked (React clears an uncontrolled form after every
 * submit). A password is never returned.
 */
function entered(formData: FormData): AuthFormState["values"] {
  const text = (name: string) => {
    const value = formData.get(name)
    return typeof value === "string" ? value.slice(0, 254) : undefined
  }
  return { fullName: text("fullName"), email: text("email") }
}

/**
 * The address this deployment is served from, for the links in auth emails.
 * Supabase only honours a link target that is on its Redirect URLs list and
 * otherwise falls back to the Site URL, so a spoofed Host header cannot point
 * an email somewhere else.
 */
async function siteOrigin(): Promise<string | null> {
  const requestHeaders = await headers()
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host")
  if (!host) return null
  const protocol =
    requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")
  return `${protocol}://${host}`
}

const TOO_MANY = "Too many attempts. Wait a few minutes and try again."

function isRateLimited(error: { status?: number; code?: string }): boolean {
  return error.status === 429 || error.code === "over_request_rate_limit" || error.code === "over_email_send_rate_limit"
}

export async function signUpAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
    terms: formData.get("terms"),
  })

  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error), values: entered(formData) }
  }

  const supabase = await createClient()
  const origin = await siteOrigin()

  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // Read by the handle_new_user() trigger to populate profiles.full_name.
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: origin ? `${origin}/auth/confirm` : undefined,
    },
  })

  if (error) {
    return { formError: error.message, values: entered(formData) }
  }

  // When email confirmation is on, Supabase returns a user with no session.
  // Say so plainly rather than redirecting to a page they cannot yet see.
  if (data.user && !data.session) {
    return {
      success: true,
      email: parsed.data.email,
      sentAt: Date.now(),
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
    return { fieldErrors: fieldErrorsFrom(parsed.error), values: entered(formData) }
  }

  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  })

  if (error) {
    // Supabase only reports an unconfirmed address when the password was
    // right, so saying so reveals nothing an attacker could use to probe which
    // addresses are registered.
    if (error.code === "email_not_confirmed") {
      return {
        formError:
          "Your email is not confirmed yet. Open the link we sent you, or send a new one below.",
        needsConfirmation: true,
        email: parsed.data.email,
        values: entered(formData),
      }
    }
    if (isRateLimited(error)) {
      return { formError: TOO_MANY, values: entered(formData) }
    }
    // Deliberately vague for everything else. Saying "no account with that
    // email" would let someone probe which addresses are registered.
    return { formError: "That email and password combination is not correct.", values: entered(formData) }
  }

  // Only follow a redirect target that points inside this app.
  const requested = safeRedirectPath(formData.get("next")?.toString())

  revalidatePath("/", "layout")
  redirect(requested ?? DASHBOARD_ROUTE)
}

/**
 * Starts "Continue with Google" through Supabase's own Google provider.
 *
 * Google sends the person back to Supabase, which sends them to
 * `/auth/confirm?code=…`; that route exchanges the code for a session and then
 * follows `next`. The same button serves sign-in and create-account: Supabase
 * creates the account on first use, and the profile trigger takes the name
 * from Google's `full_name`. A person who already has an account under the
 * same verified email is signed into it.
 */
export async function signInWithGoogleAction(formData: FormData): Promise<void> {
  const supabase = await createClient()
  const origin = await siteOrigin()
  if (!origin) redirect(`${LOGIN_ROUTE}?error=oauth_failed`)

  const next = safeRedirectPath(formData.get("next")?.toString())
  const redirectTo = `${origin}/auth/confirm${next ? `?next=${encodeURIComponent(next)}` : ""}`

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      // Let a person with several Google accounts choose which one to use.
      queryParams: { prompt: "select_account" },
    },
  })

  if (error || !data.url) redirect(`${LOGIN_ROUTE}?error=oauth_failed`)
  redirect(data.url)
}

/**
 * Sends a new confirmation link. Always answers the same way, so it cannot be
 * used to find out which addresses have an account.
 */
export async function resendConfirmationAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") })
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error), values: entered(formData) }
  }

  const supabase = await createClient()
  const origin = await siteOrigin()

  const { error } = await supabase.auth.resend({
    type: "signup",
    email: parsed.data.email,
    options: { emailRedirectTo: origin ? `${origin}/auth/confirm` : undefined },
  })

  if (error && isRateLimited(error)) {
    return { formError: TOO_MANY }
  }

  return {
    success: true,
    email: parsed.data.email,
    sentAt: Date.now(),
    message: "If that address is waiting to be confirmed, a new link is on its way. Check your spam folder too.",
  }
}

/**
 * Starts a password reset. The answer never depends on whether the address has
 * an account, for the same reason.
 */
export async function requestPasswordResetAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") })
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error), values: entered(formData) }
  }

  const supabase = await createClient()
  const origin = await siteOrigin()

  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: origin ? `${origin}/auth/confirm?next=${RESET_PASSWORD_ROUTE}` : undefined,
  })

  if (error && isRateLimited(error)) {
    return { formError: TOO_MANY }
  }

  return {
    success: true,
    email: parsed.data.email,
    sentAt: Date.now(),
    message: "If an account exists for that address, we have sent a link to reset the password. It expires after a short time.",
  }
}

/**
 * Sets the new password. The reset link has already signed the person in with
 * a recovery session; without one there is nothing to change.
 */
export async function resetPasswordAction(
  _previous: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  })
  if (!parsed.success) {
    return { fieldErrors: fieldErrorsFrom(parsed.error), values: entered(formData) }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { formError: "This reset link has expired or was already used. Request a new one." }
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })

  if (error) {
    if (error.code === "same_password") {
      return { fieldErrors: { password: "Choose a password you have not used on this account before" } }
    }
    if (error.code === "weak_password") {
      return { fieldErrors: { password: "That password is too easy to guess. Try a longer one" } }
    }
    return { formError: "We could not update the password. Request a new reset link and try again." }
  }

  // A changed password should end every session that still holds the old one
  // (a lost phone, a shared computer) and make the person sign in with the new
  // one, including this device's recovery session. Best effort: the change has
  // already happened, so a failure here must not block the person.
  await supabase.auth.signOut({ scope: "global" })

  revalidatePath("/", "layout")
  return { success: true, message: "Your password has been changed. Sign in with the new one." }
}

export async function signOutAction() {
  const supabase = await createClient()
  await supabase.auth.signOut()

  revalidatePath("/", "layout")
  redirect(LOGIN_ROUTE)
}
