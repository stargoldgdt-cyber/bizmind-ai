import type { EmailOtpType } from "@supabase/supabase-js"
import { NextResponse, type NextRequest } from "next/server"

import { DASHBOARD_ROUTE, LOGIN_ROUTE, safeRedirectPath } from "@/config/routes"
import { createClient } from "@/lib/supabase/server"

/**
 * Where the link in a Supabase email lands.
 *
 * Handles email confirmation after signup and password-reset links. The link
 * carries a single-use `token_hash`; exchanging it here establishes the
 * session as a normal cookie write.
 *
 * The token is verified by Supabase, so a forged or expired link simply fails
 * and the visitor is returned to the login page. We never reveal which of the
 * two it was.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const tokenHash = searchParams.get("token_hash")
  const type = searchParams.get("type") as EmailOtpType | null

  // Only ever redirect somewhere inside this app.
  const next = safeRedirectPath(searchParams.get("next")) ?? DASHBOARD_ROUTE

  if (tokenHash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })

    if (!error) {
      return NextResponse.redirect(new URL(next, request.url))
    }
  }

  const failed = new URL(LOGIN_ROUTE, request.url)
  failed.searchParams.set("error", "link_invalid")
  return NextResponse.redirect(failed)
}
