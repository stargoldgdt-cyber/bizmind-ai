import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { Logo } from "@/components/brand/logo"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DASHBOARD_ROUTE } from "@/config/routes"
import { CreateBusinessForm } from "@/features/businesses/components/create-business-form"
import { getUserBusinesses } from "@/features/businesses/queries"

export const metadata: Metadata = {
  title: "Create your business",
}

/**
 * First-run: a signed-in user with no business creates one.
 *
 * Anyone who already has a business is sent onward, so this page cannot become
 * an accidental way to create duplicates by revisiting the URL.
 */
export default async function OnboardingPage() {
  const businesses = await getUserBusinesses()

  if (businesses.length > 0) {
    redirect(DASHBOARD_ROUTE)
  }

  return (
    <div className="flex min-h-dvh flex-col bg-surface-2 text-surface-2-foreground">
      <header className="px-5 py-6 sm:px-8">
        <Logo />
      </header>

      <main className="flex flex-1 items-center justify-center px-5 pb-16 sm:px-8">
        <div className="w-full max-w-md">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl">Set up your business</CardTitle>
              <CardDescription>
                This is the workspace your data connects to. You can add more
                businesses later.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CreateBusinessForm />
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
