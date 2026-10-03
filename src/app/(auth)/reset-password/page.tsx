import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, Clock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { AuthHeading } from "@/features/auth/components/auth-heading"
import { ResetPasswordForm } from "@/features/auth/components/reset-password-form"
import { createClient } from "@/lib/supabase/server"

export const metadata: Metadata = {
  title: "Create new password",
}

/**
 * The reset link signs the person in with a short-lived recovery session and
 * lands here. With no session there is nothing to change, so say so instead of
 * showing a form that cannot work.
 */
export default async function ResetPasswordPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <Card className="shadow-sm">
      <CardContent className="px-6 py-4 sm:px-8 sm:py-6">
        {user ? (
          <ResetPasswordForm />
        ) : (
          <div className="space-y-6">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-warning-subtle text-warning-foreground">
              <Clock className="size-7" aria-hidden />
            </div>
            <div className="text-center">
              <AuthHeading
                title="This link has expired"
                description="Reset links work once and stop working after a short time. Request a new one and use it straight away."
              />
            </div>
            <div className="space-y-3">
              <Button asChild size="lg" className="h-11 w-full gap-2 rounded-4xl text-sm">
                <Link href="/forgot-password">
                  Send a new reset link
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="h-11 w-full rounded-4xl text-sm">
                <Link href="/login">Back to sign in</Link>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
