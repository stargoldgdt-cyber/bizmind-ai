import type { Metadata } from "next"

import { Card, CardContent } from "@/components/ui/card"
import { FormError } from "@/features/auth/components/form-error"
import { ForgotPasswordForm } from "@/features/auth/components/forgot-password-form"

export const metadata: Metadata = {
  title: "Reset your password",
}

export default async function ForgotPasswordPage(props: PageProps<"/forgot-password">) {
  const searchParams = await props.searchParams

  // /auth/confirm sends people here when a reset link did not work.
  const linkFailed = searchParams.error === "link_invalid"

  return (
    <Card className="shadow-sm">
      <CardContent className="px-6 py-4 sm:px-8 sm:py-6">
        <ForgotPasswordForm>
          {linkFailed && (
            <FormError message="That reset link did not work. It may have expired, been used already, or been opened in a different browser from the one you asked from. Request a new one and open it in the same browser." />
          )}
        </ForgotPasswordForm>
      </CardContent>
    </Card>
  )
}
