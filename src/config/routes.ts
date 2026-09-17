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
/**
 * Every signed-in area of the product.
 *
 * `/imports` and `/integrations` were missing from this list. They were never
 * exposed — each one resolves its business from the session and redirects when
 * there isn't one, and RLS would return nothing regardless — but a signed-out
 * visitor rendered the page shell before being sent away, which is a flicker of
 * the application to someone who has not signed in.
 *
 * The rule this list exists to enforce is deny-by-default: a new page under one
 * of these prefixes is protected the moment it is created, with no chance of
 * anyone forgetting to add a guard. That only holds if the prefixes are
 * complete.
 */
export const PROTECTED_PREFIXES = [
  "/dashboard",
  "/ledger",
  "/catalog",
  "/ask",
  "/alerts",
  "/sales",
  "/products",
  "/profit",
  "/customers",
  "/expenses",
  "/health",
  "/channels",
  "/data-quality",
  "/recommendations",
  "/brief",
  "/inventory",
  "/automations",
  "/activity",
  "/imports",
  "/integrations",
  "/marketplaces",
  "/onboarding",
  "/settings",
] as const

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
