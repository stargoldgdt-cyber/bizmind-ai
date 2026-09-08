/**
 * Route policy, in one place.
 *
 * `src/proxy.ts` reads these to decide who may see what. Keeping the lists
 * here rather than scattered through the app means the answer to "is this page
 * protected?" is always in one file.
 */

/** Signed-out visitors are sent here. */
export const LOGIN_ROUTE = "/login"

/** Where a signed-in user lands when they have a business. */
export const DASHBOARD_ROUTE = "/dashboard"

/** Where a signed-in user lands when they do not yet have one. */
export const ONBOARDING_ROUTE = "/onboarding"

/**
 * Prefixes that require a signed-in user.
 *
 * Deliberately a deny-by-default list of prefixes rather than per-page checks:
 * a new page under one of these is protected the moment it is created, with no
 * chance of someone forgetting to add a guard.
 */
export const PROTECTED_PREFIXES = ["/dashboard", "/onboarding", "/settings"] as const

/**
 * Pages that only make sense when signed OUT. A signed-in user hitting these
 * is redirected onward rather than shown a login form they do not need.
 */
export const AUTH_ROUTES = ["/login", "/signup"] as const

/** The query parameter used to return someone to where they were headed. */
export const REDIRECT_PARAM = "next"

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

export function isAuthPath(pathname: string): boolean {
  return AUTH_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  )
}

/**
 * Only allow redirects to paths inside this app.
 *
 * Without this check, `?next=https://evil.example` would turn our login page
 * into an open redirect — a phishing tool that borrows our domain's
 * credibility. Anything that is not a single-slash-prefixed relative path is
 * rejected.
 */
export function safeRedirectPath(candidate: string | null | undefined): string | null {
  if (!candidate) return null
  if (!candidate.startsWith("/")) return null
  // "//host" and "/\host" are protocol-relative URLs pointing off-site.
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return null
  return candidate
}
