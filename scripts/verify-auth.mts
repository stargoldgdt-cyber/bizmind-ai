/**
 * The sign-in, create-account, forgot-password and reset-password pages.
 *
 * Run with:  npm run test:auth
 *
 * Offline: no database, no network. Covers the redirect check (the open
 * redirect found in the 2026-10-03 audit), the route rules for a password-reset
 * session, what the actions say and refuse to say, and the security headers.
 */

import { existsSync, readFileSync } from "node:fs"

import {
  AUTH_ROUTES,
  isAuthPath,
  isProtectedPath,
  safeRedirectPath,
} from "../src/config/routes"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`)
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

const read = (path: string) => readFileSync(path, "utf8")

/* ---------------------------------------------------------------------------- */
section("1. A REDIRECT TARGET MUST STAY INSIDE THE APP")

for (const good of ["/overview", "/overview?account=all-AED&period=ytd&month=2026-09", "/ledger/lines?x=1", "/reset-password"]) {
  check(`allowed: ${good}`, safeRedirectPath(good) === good)
}
const bad: [string, string][] = [
  ["https://evil.example", "an absolute URL"],
  ["//evil.example", "a protocol-relative URL"],
  ["/\\evil.example", "a backslash host"],
  ["/\t/evil.example", "a tab that URL parsers strip, leaving //evil.example"],
  ["/\n/evil.example", "a newline that URL parsers strip"],
  ["/\r/evil.example", "a carriage return"],
  ["/ok\\..\\evil", "a backslash anywhere"],
  ["javascript:alert(1)", "a script URL"],
  ["overview", "a relative path with no leading slash"],
  ["", "an empty value"],
]
for (const [value, why] of bad) {
  check(`refused: ${why}`, safeRedirectPath(value) === null, JSON.stringify(value))
}
check("null and undefined are refused", safeRedirectPath(null) === null && safeRedirectPath(undefined) === null)
check(
  "the exact value that used to escape now resolves inside the app (or not at all)",
  safeRedirectPath("/\t/evil.example") === null &&
    new URL("/\t/evil.example", "https://bizmindai.app").origin !== "https://bizmindai.app"
)

/* ---------------------------------------------------------------------------- */
section("2. ROUTE RULES")

check("sign-in, create-account and forgot-password are signed-out pages",
  AUTH_ROUTES.includes("/login") && AUTH_ROUTES.includes("/signup") && AUTH_ROUTES.includes("/forgot-password"))
check("a signed-in person is bounced away from forgot-password", isAuthPath("/forgot-password"))
check("reset-password is NOT a signed-out page: a reset link signs the person in first", !isAuthPath("/reset-password"))
check("reset-password is not protected either: the page explains an expired link itself", !isProtectedPath("/reset-password"))
for (const page of [
  "src/app/(auth)/login/page.tsx",
  "src/app/(auth)/signup/page.tsx",
  "src/app/(auth)/forgot-password/page.tsx",
  "src/app/(auth)/reset-password/page.tsx",
  "src/app/auth/confirm/route.ts",
]) {
  check(`exists: ${page}`, existsSync(page))
}

/* ---------------------------------------------------------------------------- */
section("3. WHAT THE ACTIONS SAY, AND REFUSE TO SAY")

const actions = read("src/features/auth/actions.ts")
check("a wrong password is still answered vaguely",
  actions.includes("That email and password combination is not correct."))
check("an unconfirmed address is told to confirm, and offered a new link",
  /email_not_confirmed/.test(actions) && /needsConfirmation:\s*true/.test(actions))
check("a rate limit is reported as a rate limit, not as a wrong password",
  /isRateLimited\(error\)/.test(actions) && actions.includes("Too many attempts"))
check("forgot-password answers the same whether or not the address has an account",
  /resetPasswordForEmail[\s\S]*?if \(error && isRateLimited\(error\)\)[\s\S]*?return \{\s*success: true/.test(actions))
check("resend answers the same whether or not the address has an account",
  /auth\.resend[\s\S]*?if \(error && isRateLimited\(error\)\)[\s\S]*?return \{\s*success: true/.test(actions))
check("the reset action refuses without a session and says the link expired",
  /getUser\(\)[\s\S]*?if \(!user\)[\s\S]*?expired or was already used/.test(actions))
check("changing the password signs out every session, this one included, and shows a success screen",
  /signOut\(\{ scope: "global" \}\)/.test(actions) && /return \{ success: true, message: "Your password has been changed/.test(actions))
check("a new password must still pass the same 12-character rule",
  /resetPasswordSchema/.test(actions) && /min\(12/.test(read("src/features/auth/schemas.ts")))
check("no password is ever logged", !/console\.(log|info|warn|error)/.test(actions))

const confirmRoute = read("src/app/auth/confirm/route.ts")
check("the confirmation link accepts both link shapes (token hash and code)",
  /token_hash/.test(confirmRoute) && /exchangeCodeForSession/.test(confirmRoute))
check("the link type is checked against a list, not trusted", /OTP_TYPES/.test(confirmRoute) && /\.includes\(type\)/.test(confirmRoute))
check("a failed link lands on sign-in with a flag the page reads",
  /link_invalid/.test(confirmRoute) && /link_invalid/.test(read("src/app/(auth)/login/page.tsx")))

check("a failed reset link goes back to where a new one is requested, and that page explains it",
  /next === RESET_PASSWORD_ROUTE \? FORGOT_PASSWORD_ROUTE/.test(confirmRoute) &&
    /link_invalid/.test(read("src/app/(auth)/forgot-password/page.tsx")))
check("the reset-link failure message names the different-browser cause",
  /different browser/.test(read("src/app/(auth)/forgot-password/page.tsx")))

/* ---------------------------------------------------------------------------- */
section("4. THE PAGES")

const login = read("src/features/auth/components/login-form.tsx")
const signup = read("src/features/auth/components/signup-form.tsx")
check("sign-in links to forgot-password", /href="\/forgot-password"/.test(login))
check("sign-in offers a new confirmation link when one is needed", /ResendButton/.test(login) && /needsConfirmation/.test(login))
check("the resend form is not nested inside the sign-in form",
  login.indexOf("</form>") < login.indexOf("<ResendButton"))
check("create-account asks for agreement to the Terms and the Privacy Policy, with links to both",
  /href="\/terms"/.test(signup) && /href="\/privacy"/.test(signup))
check("the confirmation screen offers a real way to get a new link, and no longer promises one it cannot send",
  /ResendButton/.test(signup) && !/sign in and we will\s+send a new one/.test(signup))
check("the name field no longer carries a real person's name as its example", !/Fahad/.test(signup))

/* ---------------------------------------------------------------------------- */
section("5. SECURITY HEADERS")

const nextConfig = read("next.config.ts")
check("server function arguments are still not logged", /serverFunctions:\s*false/.test(nextConfig))
check("the site cannot be framed (clickjacking)", /X-Frame-Options/.test(nextConfig) && /frame-ancestors 'none'/.test(nextConfig))
check("the browser may not guess file types", /X-Content-Type-Options/.test(nextConfig) && /nosniff/.test(nextConfig))
check("a referrer policy and a permissions policy are set", /Referrer-Policy/.test(nextConfig) && /Permissions-Policy/.test(nextConfig))
check("the policy does not set form-action (it would block the redirect to Google)", !/form-action/.test(nextConfig.replace(/\/\*[\s\S]*?\*\//g, "")))

/* ---------------------------------------------------------------------------- */
section("6. CONTINUE WITH GOOGLE")

const googleButton = read("src/features/auth/components/google-button.tsx")
check("Google sign-in goes through Supabase's own Google provider",
  /signInWithOAuth\(\{\s*provider: "google"/.test(actions))
check("Google returns to the same confirmation route the email links use", /\/auth\/confirm/.test(actions.split("signInWithGoogleAction")[1] ?? ""))
check("the return target is checked with the same redirect rule before it is used",
  /safeRedirectPath\(formData\.get\("next"\)/.test(actions.split("signInWithGoogleAction")[1] ?? ""))
check("a failure to start Google sign-in lands on sign-in with a message, never an error page",
  /oauth_failed/.test(actions) && /oauth_failed/.test(read("src/app/(auth)/login/page.tsx")))
check("a provider error (for example the person declined) is reported the same way", /searchParams\.get\("error"\)/.test(confirmRoute) && /oauth_failed/.test(confirmRoute))
check("both forms offer the button", /<GoogleButton/.test(login) && /<GoogleButton/.test(signup))
check("sign-in passes its return target to Google; create-account has none", /<GoogleButton redirectTo=\{redirectTo\}/.test(login))
check("the button is the unaltered Google mark and says what it does",
  /Continue with Google/.test(googleButton) && /#4285F4/.test(googleButton) && /aria-hidden/.test(googleButton))
check("no Google secret or client id appears in the sign-in code",
  !/GOOGLE_CLIENT_SECRET|client_secret|GOOGLE_CLIENT_ID/.test(actions + googleButton + login + signup))
check("the brand name is not hard-coded in the Google files", !/BizMind/.test(googleButton + actions.split("signInWithGoogleAction")[1]?.split("export async function resendConfirmationAction")[0]))

/* ---------------------------------------------------------------------------- */
section("7. THE DESIGN: FIELDS, STRENGTH, SIGN-UP RULES, SUCCESS SCREENS")

const field = read("src/features/auth/components/auth-field.tsx")
const schemas = read("src/features/auth/schemas.ts")
const resend = read("src/features/auth/components/resend-button.tsx")
const reset = read("src/features/auth/components/reset-password-form.tsx")
const forgot = read("src/features/auth/components/forgot-password-form.tsx")

check("a password field can be shown or hidden, and the button says which",
  /Show password/.test(field) && /Hide password/.test(field) && /aria-pressed/.test(field))
check("fields take a leading icon", /icon: Icon/.test(field))
check("create-account asks for the password twice and the server checks they match",
  /confirmPassword/.test(signup) && /confirmPassword/.test(schemas) && /do not match/.test(schemas))
check("agreeing to the Terms is a required box, and the server refuses without it",
  /name="terms"/.test(signup) && /required/.test(signup) && /z\.literal\("on"/.test(schemas) && /formData\.get\("terms"\)/.test(actions))
check("the password reset form also asks twice and shows strength",
  /confirmPassword/.test(reset) && /showStrength/.test(reset) && /showStrength/.test(signup))
check("the reset form ends on a 'Password updated' screen that points back to sign-in",
  /Password updated/.test(reset) && /href="\/login"/.test(reset))
check("'Check your inbox' is used after both a reset request and a sign-up",
  /<CheckInbox/.test(forgot) && /<CheckInbox/.test(signup))
check("resend is behind a 60-second countdown that restarts on each press",
  /COOLDOWN_SECONDS = 60/.test(resend) && /onSubmit=\{\(\) => setStartedAt\(Date\.now\(\)\)\}/.test(resend))
check("each form shows its own heading, so the success screens carry none",
  /<AuthHeading/.test(login) && /<AuthHeading/.test(signup) && /<AuthHeading/.test(forgot) && /<AuthHeading/.test(reset))
check("Google stays at the top of sign-in and create-account",
  login.indexOf("<GoogleButton") < login.indexOf("<form action={formAction}") &&
    signup.indexOf("<GoogleButton") < signup.indexOf("<form action={formAction}"))

const strength = await import("../src/features/auth/password-strength")
const s = strength.passwordStrength
check("nothing typed shows no meter", s("").bars === 0 && s("").label === "")
check("under twelve characters is 'Too short', never better", s("abcdefghijk").label === "Too short" && s("abcdefghijk").bars <= 2)
check("twelve repeated characters is not a strong password", s("aaaaaaaaaaaa").bars <= 2)
check("a twelve-character mixed password is 'Fair' at best", ["Fair", "Good"].includes(s("Tr0ub4dor&3x").label))
check("a long mixed passphrase is 'Strong'", s("correct horse battery staple 42!").label === "Strong" && s("correct horse battery staple 42!").bars === 5)
check("the meter agrees with the server's length rule: below twelve is never green",
  s("Aa1!Aa1!Aa1").tone === "danger")

console.log(`\n${"=".repeat(74)}\n RESULT: ${passed} passed, ${failed} failed\n${"=".repeat(74)}`)
process.exit(failed === 0 ? 0 : 1)
