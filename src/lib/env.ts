import { z } from "zod"

/**
 * Environment variable validation.
 *
 * Reads and checks configuration once, at startup, so a missing or malformed
 * value fails immediately with a readable message instead of surfacing later
 * as a confusing runtime error deep inside a request.
 *
 * Only PUBLIC values are declared here. Server-only secrets (the Supabase
 * service-role key, the OpenAI key) are deliberately absent — they are read
 * where they are used, on the server, so there is no chance of one being
 * pulled into a browser bundle by accident.
 */

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .url("NEXT_PUBLIC_SUPABASE_URL must be a full URL, e.g. https://abcdefgh.supabase.co")
    /**
     * Must be the bare project URL with no path.
     *
     * The Supabase dashboard also displays a REST endpoint ending in
     * `/rest/v1/`, which is easy to copy by mistake. The client library appends
     * its own paths (`/auth/v1`, `/rest/v1`), so a URL that already has one
     * produces requests to `/rest/v1/auth/v1/...` — every call fails with an
     * error that says nothing about the real cause. Catch it here instead.
     */
    .refine(
      (value) => {
        try {
          return new URL(value).pathname === "/"
        } catch {
          return false
        }
      },
      {
        message:
          "NEXT_PUBLIC_SUPABASE_URL must end at .supabase.co with nothing after it. " +
          "Remove any trailing path such as /rest/v1/ — the URL should look like " +
          "https://abcdefgh.supabase.co",
      }
    )
    // Trailing slashes are harmless but produce doubled slashes in request
    // URLs, so normalise rather than rejecting.
    .transform((value) => value.replace(/\/+$/, "")),

  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, "NEXT_PUBLIC_SUPABASE_ANON_KEY looks too short to be a real key")
    /**
     * Guard against pasting the service-role key here. That key bypasses Row
     * Level Security entirely, and anything in NEXT_PUBLIC_* is shipped to the
     * browser — so this mistake would hand every visitor full database access.
     * Worth an explicit check rather than trusting that nobody ever slips.
     */
    .refine((value) => !/"role"\s*:\s*"service_role"/.test(decodeJwtPayload(value)), {
      message:
        "That looks like the SERVICE ROLE key, which must never be public. " +
        "Use the key labelled 'anon' or 'publishable' instead, and rotate the " +
        "service-role key in your Supabase dashboard if it has been exposed.",
    }),
})

/**
 * Best-effort decode of a JWT payload for the check above. Returns an empty
 * string for anything that is not a JWT — newer Supabase publishable keys are
 * opaque strings, and those are fine.
 */
function decodeJwtPayload(token: string): string {
  const payload = token.split(".")[1]
  if (!payload) return ""

  try {
    return Buffer.from(payload, "base64url").toString("utf8")
  } catch {
    return ""
  }
}

/**
 * Next.js inlines `process.env.NEXT_PUBLIC_*` at build time only when each one
 * is written out literally. Destructuring or dynamic access would leave these
 * undefined in the browser, so they are listed explicitly.
 */
const parsed = publicEnvSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
})

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  • ${issue.path.join(".")}: ${issue.message}`)
    .join("\n")

  throw new Error(
    `\nBizMind is not configured correctly.\n\n${problems}\n\n` +
      `Copy .env.example to .env.local, fill in the values, then restart the ` +
      `server. Environment variables are only read at startup.\n`
  )
}

export const env = parsed.data
