import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

import {
  DASHBOARD_ROUTE,
  LOGIN_ROUTE,
  REDIRECT_PARAM,
  isAuthPath,
  isProtectedPath,
} from "@/config/routes"
import { env } from "@/lib/env"

/**
 * Runs before every matched request.
 *
 * NOTE ON THE FILENAME: in Next.js 16 this file is `proxy.ts` and the export
 * is `proxy`. The old `middleware.ts` / `middleware()` convention is
 * deprecated. It also runs on the Node.js runtime, not the edge.
 *
 * It does two jobs:
 *
 *  1. Refreshes the Supabase session. Access tokens are short-lived; without a
 *     refresh here users would be logged out at unpredictable moments. Server
 *     Components cannot write cookies, so this is the only place the refreshed
 *     tokens can be persisted.
 *
 *  2. Enforces route access, so a protected page is never rendered — not even
 *     briefly — for a signed-out visitor.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }

          response = NextResponse.next({ request })

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }

          // Supabase supplies no-store cache headers alongside auth cookies.
          // They must be applied: a cached response carrying a Set-Cookie
          // could hand one user's session to a different user.
          for (const [key, headerValue] of Object.entries(headers ?? {})) {
            response.headers.set(key, headerValue)
          }
        },
      },
    }
  )

  // Do not insert code between creating the client and this call. getUser()
  // revalidates the token with the auth server, so its result is safe to make
  // authorization decisions with — unlike a session read from a cookie, which
  // a client could forge.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname, search } = request.nextUrl

  // Signed out, heading somewhere protected → login, remembering the target.
  if (!user && isProtectedPath(pathname)) {
    const loginUrl = new URL(LOGIN_ROUTE, request.url)
    loginUrl.searchParams.set(REDIRECT_PARAM, `${pathname}${search}`)
    return NextResponse.redirect(loginUrl)
  }

  // Signed in, heading to login or signup → send them into the app instead.
  if (user && isAuthPath(pathname)) {
    return NextResponse.redirect(new URL(DASHBOARD_ROUTE, request.url))
  }

  return response
}

export const config = {
  /**
   * Run on everything except static assets and image files.
   *
   * Without this exclusion the auth check would also run for CSS, JavaScript
   * and images, which is wasted work and can block those assets from loading.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)",
  ],
}
