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
    .url("NEXT_PUBLIC_SUPABASE_URL must be a full URL, e.g. https://abcdefgh.supabase.co"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, "NEXT_PUBLIC_SUPABASE_ANON_KEY looks too short to be a real key"),
})

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
