/**
 * A hint for the person typing, not a security control. The only rule the
 * server enforces is length (schemas.ts); this just shows how a password is
 * doing against it. Length is what makes a password hard to guess, so it
 * drives the score; variety nudges it up a step.
 */

export type PasswordStrength = {
  /** How many of the five bars to fill. */
  bars: 0 | 1 | 2 | 3 | 4 | 5
  label: "" | "Too short" | "Weak" | "Fair" | "Good" | "Strong"
  tone: "none" | "danger" | "warning" | "success"
}

export const MIN_PASSWORD_LENGTH = 12

export function passwordStrength(value: string): PasswordStrength {
  if (value.length === 0) return { bars: 0, label: "", tone: "none" }

  if (value.length < MIN_PASSWORD_LENGTH) {
    return { bars: value.length < 6 ? 1 : 2, label: "Too short", tone: "danger" }
  }

  // Twelve or more characters, but one or two repeated characters is not a password.
  if (new Set(value).size <= 3) return { bars: 2, label: "Weak", tone: "danger" }

  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((kind) => kind.test(value)).length

  let bars = 3
  if (value.length >= 16) bars += 1
  if (value.length >= 20) bars += 1
  if (kinds >= 3 && bars < 5) bars += 1

  if (bars <= 3) return { bars: 3, label: "Fair", tone: "warning" }
  if (bars === 4) return { bars: 4, label: "Good", tone: "success" }
  return { bars: 5, label: "Strong", tone: "success" }
}
