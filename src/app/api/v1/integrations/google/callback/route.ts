import { cookies } from "next/headers"
import { NextResponse } from "next/server"

import { getActiveBusiness } from "@/features/businesses/queries"
import { encryptCredential, signaturesMatch } from "@/lib/crypto"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import {
  exchangeCode,
  googleOAuthConfig,
} from "@/services/integrations/connectors/google-sheets/oauth"
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
  openOAuthState,
} from "@/services/integrations/connectors/google-sheets/state"
import { storeIntegrationCredentials } from "@/services/integrations/security/store-secrets"

/**
 * Google sends the browser back here after consent.
 *
 * In order, and nothing later happens if an earlier step fails:
 *   1. a signed-in owner or admin, in the business the sign-in started from
 *   2. the sealed state cookie opens for that user and business, is unexpired,
 *      and matches the `state` Google echoed -- compared in constant time
 *   3. the code is exchanged SERVER-SIDE, with the client secret
 *   4. the business's Google integration row is created or refreshed, as the
 *      signed-in owner, under their role check
 *   5. the refresh token is sealed to this business and stored by the one
 *      confined writer -- never logged, never returned
 *
 * The state cookie is cleared on every outcome, so it can be used once.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const url = new URL(request.url)

  const finish = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url))
    response.cookies.set(OAUTH_STATE_COOKIE, "", { path: OAUTH_STATE_COOKIE_PATH, maxAge: 0 })
    return response
  }
  const back = (outcome: string) => finish(`/integrations?google=${outcome}`)

  const user = await getCurrentUser()
  if (!user) return finish("/login?next=/integrations")

  const business = await getActiveBusiness()
  if (!business) return finish("/onboarding")
  if (business.role !== "OWNER" && business.role !== "ADMIN") return back("forbidden")

  // 2. The handshake.
  const jar = await cookies()
  const sealed = jar.get(OAUTH_STATE_COOKIE)?.value
  const nonce = sealed ? openOAuthState(sealed, { userId: user.id, businessId: business.id }) : null
  const echoed = url.searchParams.get("state") ?? ""

  if (!nonce || !signaturesMatch(nonce, echoed)) return back("expired")

  // The owner declined, or Google reported a problem.
  if (url.searchParams.get("error")) return back("denied")

  const code = url.searchParams.get("code")
  if (!code) return back("denied")

  const config = googleOAuthConfig()
  if (!config) return back("not_configured")

  // 3. The exchange.
  const exchange = await exchangeCode(code, config)
  if (!exchange.ok) return back(exchange.reason)

  // 4. The business's Google integration, as the signed-in owner.
  const supabase = await createClient()
  const { data: integration, error } = await supabase.rpc("integration_google_authorize", {
    p_business_id: business.id,
  })

  if (error || !integration) {
    console.error("[google] recording the Google connection failed:", error?.message ?? "no row")
    return back("failed")
  }

  // 5. Seal and store. `api_credentials` is the purpose the sync worker
  // decrypts with, so the worker can use it without special cases.
  const sealedCredentials = encryptCredential(
    JSON.stringify({ refresh_token: exchange.refreshToken }),
    { businessId: business.id, purpose: "api_credentials" }
  )

  const stored = await storeIntegrationCredentials(integration.id, sealedCredentials)
  if (!stored) return back("failed")

  return back("connected")
}
