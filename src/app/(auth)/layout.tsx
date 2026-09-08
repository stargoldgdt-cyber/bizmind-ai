import Link from "next/link"

import { Logo } from "@/components/brand/logo"
import { siteConfig } from "@/config/site"

/**
 * Shell for signed-out pages.
 *
 * Sits on surface-2 so the white card carries the eye — separation by surface
 * contrast rather than by a heavy shadow.
 */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-2 text-surface-2-foreground">
      <header className="px-5 py-6 sm:px-8">
        <Link href="/" aria-label={`${siteConfig.name} home`}>
          <Logo />
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 pb-16 sm:px-8">
        <div className="w-full max-w-md">{children}</div>
      </main>

      <footer className="px-5 pb-8 text-center text-xs text-surface-2-muted sm:px-8">
        <p>{siteConfig.tagline}</p>
      </footer>
    </div>
  )
}
