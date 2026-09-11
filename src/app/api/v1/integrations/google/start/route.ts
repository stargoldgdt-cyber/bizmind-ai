import { NextResponse } from "next/server"

import { getActiveBusiness } from "@/features/businesses/queries"
import { isEncryptionConfigured } from "@/lib/crypto"
import { getCurrentUser } from "@/lib/supabase/server"
import {
  buildConsentUrl,
  googleOAuthConfig,
} from "@/services/integrations/connectors/google-sheets/oauth"
import {
  newOAuthState,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
  OAUTH_STATE_MAX_AGE_SECONDS,
  sealOAuthState,
} from "@/services/integrations/connectors/google-sheets/state"

/**
 * "Connect Google" -- the first step of the sign-in.
 *
 * Checks the person may connect things for this business, seals a one-time
 * state into an httpOnly cookie, and sends the browser to Google's consent
 * screen. No token exists yet, and none will ever be sent to the browser.
 *
 * The business is the one the signed-in owner is working in, from the session.
 * Nothing in the request can choose a different one.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const back = (outcome: string) =>
    NextResponse.redirect(new URL(`/integrations?google=${outcome}`, request.url))

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.redirect(new URL("/login?next=/integrations", request.url))
  }

  const business = await getActiveBusiness()
  if (!business) return NextResponse.redirect(new URL("/onboarding", request.url))

  if (business.role !== "OWNER" && business.role !== "ADMIN") return back("forbidden")

  const config = googleOAuthConfig()
  if (!config || !isEncryptionConfigured()) return back("not_configured")

  const nonce = newOAuthState()
  const response = NextResponse.redirect(buildConsentUrl(config, nonce))

  response.cookies.set(
    OAUTH_STATE_COOKIE,
    sealOAuthState({ nonce, userId: user.id, businessId: business.id }),
    {
      httpOnly: true,
      // Lax, not Strict: Google returns the browser with a top-level GET, and
      // a Strict cookie would not be sent on that navigation.
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      path: OAUTH_STATE_COOKIE_PATH,
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    }
  )

  return response
}
