import { z } from "zod"

/**
 * Validation for creating and switching businesses. Runs on the server.
 */

/**
 * Turns "Fahad's Trading Co." into "fahads-trading-co".
 *
 * The slug is a URL-safe identifier for the business. Generated rather than
 * typed, because asking a non-technical owner to invent one is friction they
 * do not need.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    // Strip accents so "Café" becomes "cafe" rather than losing the letter.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

export const createBusinessSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Give your business a name of at least 2 characters")
    .max(120, "That name is too long"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Choose a currency")
    .regex(/^[A-Z]{3}$/, "Currency must be a three-letter code such as BDT or USD"),
})

export type CreateBusinessInput = z.infer<typeof createBusinessSchema>

export type BusinessFormState = {
  formError?: string
  fieldErrors?: Partial<Record<string, string>>
}

/**
 * Currencies offered at signup. Deliberately short — a long list is harder to
 * use than a short one plus the ability to change it later in settings.
 */
export const SUPPORTED_CURRENCIES = [
  { code: "BDT", label: "BDT — Bangladeshi Taka" },
  { code: "USD", label: "USD — US Dollar" },
  { code: "EUR", label: "EUR — Euro" },
  { code: "GBP", label: "GBP — British Pound" },
  { code: "INR", label: "INR — Indian Rupee" },
  { code: "AED", label: "AED — UAE Dirham" },
  { code: "PKR", label: "PKR — Pakistani Rupee" },
] as const
