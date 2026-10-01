import type { Metadata } from "next"

import { siteConfig } from "@/config/site"
import { LegalPage } from "@/features/marketing/components/legal-page"
import { privacyPolicy } from "@/features/marketing/legal"

export const metadata: Metadata = {
  title: `Privacy Policy — ${siteConfig.name}`,
  description: "What BizMind collects, why, where it is kept, and what you can ask us to do with it.",
}

export default function PrivacyPage() {
  return <LegalPage document={privacyPolicy} />
}
