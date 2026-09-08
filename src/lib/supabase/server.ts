import { cookies } from "next/headers"
import { createServerClient } from "@supabase/ssr"

import { env } from "@/lib/env"
import type { Database } from "@/types/database"

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * A NEW client is created per request. Never cache one in a module-level
 * variable — a shared client would leak one user's session into another
 * user's request.
 *
 * This uses the anon key and therefore runs as the signed-in user, with Row
 * Level Security applied. That is exactly what we want: the database enforces
 * tenant isolation even if a query here forgets to scope itself.
 */
export async function createClient() {
  // Async in Next.js 16 — synchronous cookie access was removed.
  const cookieStore = await cookies()

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Server Components cannot set cookies. This is expected and safe:
            // src/proxy.ts refreshes the session on every request, so the
            // refreshed cookies are written there instead.
          }
        },
      },
    }
  )
}

/**
 * The signed-in user, or null.
 *
 * Always use this rather than reading the session from a cookie. `getUser()`
 * revalidates the token with the Supabase Auth server, so it cannot be
 * spoofed by a forged cookie. Session data read straight from a cookie is
 * NOT trustworthy for authorization decisions.
 */
export async function getCurrentUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return user
}
