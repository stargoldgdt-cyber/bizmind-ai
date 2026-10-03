import type { Metadata } from "next"

import { Card, CardContent } from "@/components/ui/card"
import { SignupForm } from "@/features/auth/components/signup-form"

export const metadata: Metadata = {
  title: "Create your account",
}

export default function SignupPage() {
  return (
    <Card className="shadow-sm">
      <CardContent className="px-6 py-4 sm:px-8 sm:py-6">
        <SignupForm />
      </CardContent>
    </Card>
  )
}
