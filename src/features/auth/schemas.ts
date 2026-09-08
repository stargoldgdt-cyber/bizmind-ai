import { z } from "zod"

/**
 * Validation for every auth form.
 *
 * These run on the SERVER, inside the server action. Client-side validation is
 * a convenience for the person typing; it is not a security control, because
 * anything in the browser can be bypassed. The server never trusts input it
 * has not checked itself.
 */

const email = z
  .string()
  .trim()
  .min(1, "Enter your email address")
  .pipe(z.email("That does not look like a valid email address"))
  .transform((value) => value.toLowerCase())

/**
 * Length is the property that actually makes a password hard to guess, so the
 * minimum is generous and there are no composition rules. Forcing symbols and
 * digits pushes people toward predictable patterns like "Password1!" and
 * toward reusing passwords, which makes accounts less safe, not more.
 */
const password = z
  .string()
  .min(12, "Use at least 12 characters — length matters more than symbols")
  .max(72, "Passwords cannot be longer than 72 characters")

export const signUpSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, "Enter your name")
    .max(120, "That name is too long"),
  email,
  password,
})

export const signInSchema = z.object({
  email,
  // Not re-validated for length: an existing account may predate a rule
  // change, and telling an attacker "wrong length" leaks information.
  password: z.string().min(1, "Enter your password"),
})

export type SignUpInput = z.infer<typeof signUpSchema>
export type SignInInput = z.infer<typeof signInSchema>

/**
 * What a form gets back from a server action.
 *
 * `fieldErrors` positions a message under the input it belongs to;
 * `formError` covers everything else, such as bad credentials.
 */
export type AuthFormState = {
  formError?: string
  fieldErrors?: Partial<Record<string, string>>
  success?: boolean
  message?: string
}
