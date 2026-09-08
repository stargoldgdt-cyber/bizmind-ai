"use client"

import { createBrowserClient } from "@supabase/ssr"

import { env } from "@/lib/env"
import type { Database } from "@/types/database"

/**
 * Supabase client for the browser.
 *
 * Uses the anon key, which is public by design — it identifies the project,
 * it does not grant access. Row Level Security is what actually protects the
 * data, which is why every table has policies and why no table is ever
 * created without them.
 *
 * Prefer fetching data on the server. Use this only where the browser
 * genuinely needs Supabase directly: realtime subscriptions, file uploads, or
 * client-side auth state changes.
 */
export function createClient() {
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}
