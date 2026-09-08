import { redirect } from "next/navigation"

import { LOGIN_ROUTE } from "@/config/routes"
import { getCurrentUser } from "@/lib/supabase/server"

/**
 * Shell for everything behind a login.
 *
 * `src/proxy.ts` already blocks signed-out visitors before a page renders.
 * This check repeats it on purpose: if the proxy matcher were ever changed and
 * a path slipped through, the page still refuses to render rather than leaking
 * data. Authorization is cheap; a leak is not.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser()

  if (!user) {
    redirect(LOGIN_ROUTE)
  }

  return <div className="min-h-dvh bg-surface-1 text-surface-1-foreground">{children}</div>
}
