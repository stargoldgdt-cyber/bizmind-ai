import type { Metadata, Viewport } from "next"
import { cn } from "cn"

import { TooltipProvider } from "@/components/ui/tooltip"
import { fontVariables } from "@/config/fonts"
import { siteConfig } from "@/config/site"

import "./globals.css"

export const metadata: Metadata = {
  title: {
    default: `${siteConfig.name} — ${siteConfig.shortName} Business Intelligence`,
    template: `%s — ${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0b15" },
  ],
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={cn("font-sans", fontVariables)}>
      {/* Browser extensions (e.g. WOT) add attributes to <body> before React
          loads; this silences that one mismatch on this element only. */}
      <body className="min-h-dvh antialiased" suppressHydrationWarning>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  )
}
