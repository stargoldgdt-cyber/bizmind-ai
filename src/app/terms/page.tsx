import type { Metadata } from "next"

import { siteConfig } from "@/config/site"
import { LegalPage } from "@/features/marketing/components/legal-page"
import { termsOfService } from "@/features/marketing/legal"

export const metadata: Metadata = {
  title: `Terms of Service — ${siteConfig.name}`,
  description: "The agreement between you and BizMind: what the service does, what it does not, and who is responsible for what.",
}

export default function TermsPage() {
  return <LegalPage document={termsOfService} />
}
