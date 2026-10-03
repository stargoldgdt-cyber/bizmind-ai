import type { Metadata } from "next"

import { Card, CardContent } from "@/components/ui/card"
import { REDIRECT_PARAM, safeRedirectPath } from "@/config/routes"
import { FormError } from "@/features/auth/components/form-error"
import { LoginForm } from "@/features/auth/components/login-form"

export const metadata: Metadata = {
  title: "Sign in",
}

export default async function LoginPage(props: PageProps<"/login">) {
  // searchParams is a Promise in Next.js 16.
  const searchParams = await props.searchParams
  const requested = searchParams[REDIRECT_PARAM]

  // Sanitised here as well as in the action. The value reaches a hidden input,
  // so it must not be allowed to point off-site.
  const redirectTo = safeRedirectPath(
    Array.isArray(requested) ? requested[0] : requested
  )

  // /auth/confirm sends people here with these flags when an email link or a
  // Google attempt failed. It never says which way a link failed (expired,
  // reused or forged).
  const linkFailed = searchParams.error === "link_invalid"
  const googleFailed = searchParams.error === "oauth_failed"

  return (
    <Card className="shadow-sm">
      <CardContent className="px-6 py-4 sm:px-8 sm:py-6">
        <LoginForm redirectTo={redirectTo ?? undefined}>
          {linkFailed && (
            <FormError message="That link has expired or was already used. If you just confirmed your email, sign in below. Otherwise use “Forgot password?” or sign in to get a new confirmation link." />
          )}
          {googleFailed && (
            <FormError message="Google sign-in did not complete. Try again, or use your email and password." />
          )}
        </LoginForm>
      </CardContent>
    </Card>
  )
}
