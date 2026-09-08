import type { Metadata } from "next"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { REDIRECT_PARAM, safeRedirectPath } from "@/config/routes"
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

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>Sign in to your BizMind account.</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm redirectTo={redirectTo ?? undefined} />
      </CardContent>
    </Card>
  )
}
