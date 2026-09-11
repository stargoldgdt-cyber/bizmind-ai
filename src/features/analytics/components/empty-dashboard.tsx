import Link from "next/link"
import { ArrowRight, FileSpreadsheet, Plug } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * The dashboard when there is nothing to show.
 *
 * TWO DIFFERENT SILENCES, TWO DIFFERENT ANSWERS
 * ---------------------------------------------
 * "You have never imported anything" and "this particular fortnight was quiet"
 * look identical on screen and need completely different responses. The first
 * is an onboarding moment. The second is a fact about the business, where the
 * right move is usually to widen the period — telling that owner to import
 * data they already imported is how a product looks broken.
 *
 * `hasAnyData` distinguishes them, and it is answered by counting records
 * outside the selected period rather than inside it.
 *
 * WHY THE PREVIOUS VERSION WAS A P0
 * ---------------------------------
 * It was an icon, the sentence "No sales in this period", and nothing else.
 * No button, no next step, on the screen a new owner sees first. The most
 * important moment in the product was a dead end.
 */
export function EmptyDashboard({
  hasAnyData,
  periodLabel,
}: {
  hasAnyData: boolean
  periodLabel: string
}) {
  if (hasAnyData) {
    return (
      <div className="mt-6 rounded-xl border border-border bg-card px-6 py-14 text-center">
        <h2 className="font-heading text-lg font-semibold">
          No sales in {periodLabel.toLowerCase()}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Your records are here — there simply were no orders in this window.
          Try a longer period, or import the export that covers it.
        </p>

        <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <Button asChild variant="outline" className="rounded-4xl">
            <Link href="/dashboard?range=365d">Look at the last 12 months</Link>
          </Button>
          <Button asChild variant="ghost" className="rounded-4xl">
            <Link href="/imports/new">Import more data</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-6 py-10 sm:px-10 sm:py-12">
        <h2 className="font-heading text-xl font-bold tracking-tight sm:text-2xl">
          No business data yet
        </h2>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Bring in one sales export and BizMind will show you what your business
          actually earned — after costs, fees and refunds.
        </p>

        <div className="mt-7 flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <Button asChild size="lg" className="h-11 rounded-4xl px-6">
            <Link href="/imports/new">
              <FileSpreadsheet className="size-4" aria-hidden />
              Import Excel or CSV
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Link>
          </Button>

          <Button asChild size="lg" variant="outline" className="h-11 rounded-4xl px-6">
            <Link href="/integrations">
              <Plug className="size-4" aria-hidden />
              Connect a store
            </Link>
          </Button>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          A spreadsheet with order dates, amounts and — ideally — costs is
          enough to start.
        </p>
      </div>

      {/*
        What appears once data lands. Concrete, and every item is something
        the dashboard genuinely renders, so this is a preview rather than a
        promise.
      */}
      <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
        {WHAT_APPEARS.map((item) => (
          <div key={item.title} className="bg-card px-5 py-5">
            <p className="text-sm font-medium">{item.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

const WHAT_APPEARS = [
  {
    title: "True margin",
    detail: "Profit after cost of goods, marketplace fees and refunds.",
  },
  {
    title: "Channel profitability",
    detail: "Which channel earns most, not just which sells most.",
  },
  {
    title: "Business health",
    detail: "A score, with the reasoning behind every part of it.",
  },
  {
    title: "Data quality",
    detail: "What is missing, and how much it affects your figures.",
  },
] as const
