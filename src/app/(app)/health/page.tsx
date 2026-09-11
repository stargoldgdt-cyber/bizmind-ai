import type { Metadata } from "next"

import { AppShell } from "@/components/layout/app-shell"
import { HealthCard } from "@/features/analytics/components/health-card"
import { InsightList } from "@/features/analytics/components/insight-list"
import { PageHeader } from "@/features/analytics/components/page-header"
import { loadAnalyticsPage } from "@/features/analytics/page-context"

export const metadata: Metadata = { title: "Business health" }

/**
 * Business health.
 *
 * The score and, more importantly, the reasoning behind each dimension.
 *
 * The health engine already refuses to score a dimension it cannot measure —
 * it returns null rather than 50, because "we do not know" and "average" are
 * different answers and collapsing them manufactures a fact. It also marks a
 * dimension built on unreliable inputs as low confidence and says why.
 * `HealthCard` renders both, so an incomplete score never looks authoritative.
 *
 * Nothing on this page is computed here.
 */
export default async function HealthPage(props: PageProps<"/health">) {
  const context = await loadAnalyticsPage(await props.searchParams)
  const { analytics, business, period, hasSales } = context

  return (
    <AppShell
      businesses={context.businesses}
      activeBusinessId={business.id}
      userEmail={context.user.email}
      userName={context.userName}
    >
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Business health"
          description="A score you can interrogate. Each dimension says what it measured and how much it could rely on."
          period={period}
          currency={business.currency}
          basePath="/health"
        />

        {!hasSales ? (
          <p className="mt-8 rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
            There is nothing to score in this period. Health is measured from
            the sales, costs and expenses recorded in the selected range.
          </p>
        ) : (
          <>
            <div className="mt-8">
              <HealthCard health={analytics.health} currency={business.currency} />
            </div>

            <section className="mt-4" aria-label="Findings">
              <InsightList insights={analytics.insights} currency={business.currency} />
            </section>
          </>
        )}
      </div>
    </AppShell>
  )
}
