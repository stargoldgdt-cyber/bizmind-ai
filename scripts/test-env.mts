/**
 * Configuration for the test suites that run against the live database.
 *
 * Reads, in order of precedence:
 *   1. the real environment  (CI sets it there)
 *   2. .env.test.local       (local QA credentials -- gitignored)
 *   3. .env.local            (the Supabase project URL and anon key)
 *
 * No credential is ever written into a script. `.env.test.local` holds
 * throwaway QA sign-ins for the developer's own Supabase project; it is
 * gitignored and must never contain a real customer's password.
 */

import { readFileSync } from "node:fs"

function readEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {}
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (match) out[match[1]] = match[2].trim()
    }
    return out
  } catch {
    // A missing file is normal -- CI supplies the environment directly.
    return {}
  }
}

const files = { ...readEnvFile(".env.local"), ...readEnvFile(".env.test.local") }

/** Real environment wins, so CI and one-off overrides always take precedence. */
function read(key: string): string | undefined {
  return process.env[key] ?? files[key]
}

export const SUPABASE_URL = read("NEXT_PUBLIC_SUPABASE_URL")
export const ANON_KEY = read("NEXT_PUBLIC_SUPABASE_ANON_KEY")
export const TEST_EMAIL = read("BIZMIND_TEST_EMAIL")
export const TEST_PASSWORD = read("BIZMIND_TEST_PASSWORD")
export const OTHER_EMAIL = read("BIZMIND_OTHER_EMAIL")
export const OTHER_PASSWORD = read("BIZMIND_OTHER_PASSWORD")

/**
 * Exits with a readable message rather than a stack trace, because these
 * suites are usually run by hand.
 */
export function requireConfig(options: { second?: boolean } = {}) {
  if (!SUPABASE_URL || !ANON_KEY) {
    console.error("Supabase is not configured. Set up .env.local first.")
    process.exit(1)
  }
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.error(
      "Missing QA credentials.\n" +
        "Create .env.test.local with BIZMIND_TEST_EMAIL and BIZMIND_TEST_PASSWORD.\n" +
        "It is gitignored, so nothing is committed."
    )
    process.exit(1)
  }
  if (options.second && (!OTHER_EMAIL || !OTHER_PASSWORD)) {
    console.error(
      "This suite proves one tenant cannot read another, so it needs a SECOND\n" +
        "sign-in: add BIZMIND_OTHER_EMAIL and BIZMIND_OTHER_PASSWORD to .env.test.local."
    )
    process.exit(1)
  }
  return {
    url: SUPABASE_URL,
    anonKey: ANON_KEY,
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    otherEmail: OTHER_EMAIL ?? "",
    otherPassword: OTHER_PASSWORD ?? "",
  }
}
