import type { EmailOtpType } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"

import {
  DASHBOARD_ROUTE,
  FORGOT_PASSWORD_ROUTE,
  LOGIN_ROUTE,
  RESET_PASSWORD_ROUTE,
  safeRedirectPath,
} from "@/config/routes"
import { createClient } from "@/lib/supabase/server"

/**
 * Where the link in a Supabase email lands.
 *
 * Handles email confirmation after signup and password-reset links. Two link
 * shapes arrive here, depending on the email template in use:
 *
 *  - `token_hash` + `type`: a single-use hash verified directly.
 *  - `code`: the PKCE hand-back that Supabase's default templates use, which
 *    is exchanged for a session. It only completes in the browser that asked
 *    for the email; elsewhere the address is still confirmed, and the visitor
 *    is told to sign in.
 *
 * Either way the token is verified by Supabase, so a forged or expired link
 * simply fails and the visitor is returned to the login page. We never reveal
 * which of the two it was.
 */
const OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "recovery",
  "email",
  "invite",
  "magiclink",
  "email_change",
]

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const tokenHash = searchParams.get("token_hash")
  const type = searchParams.get("type")
  const code = searchParams.get("code")

  // Only ever redirect somewhere inside this app.
  const next = safeRedirectPath(searchParams.get("next")) ?? DASHBOARD_ROUTE

  // The provider (Google) or Supabase reports a problem, such as the person
  // declining on the consent screen, as `error` on this same address.
  if (searchParams.get("error")) {
    const declined = new URL(LOGIN_ROUTE, request.url)
    declined.searchParams.set("error", "oauth_failed")
    return NextResponse.redirect(declined)
  }

  const supabase = await createClient()

  if (tokenHash && type && (OTP_TYPES as readonly string[]).includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash })
    if (!error) return NextResponse.redirect(new URL(next, request.url))
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(next, request.url))
  }

  // A failed reset link goes back to where a new one is requested, not to
  // sign-in, which would tell the person nothing useful about it.
  const failed = new URL(next === RESET_PASSWORD_ROUTE ? FORGOT_PASSWORD_ROUTE : LOGIN_ROUTE, request.url)
  failed.searchParams.set("error", "link_invalid")
  return NextResponse.redirect(failed)
}
