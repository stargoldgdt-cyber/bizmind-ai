"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { ExternalLink } from "lucide-react"

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"

/**
 * A product's costs, SKUs and details in a side panel over Products and
 * costs, so nothing needs a separate page. The panel is open while the URL
 * carries ?product=<id>; closing it returns to the list where it was.
 */
export function ProductPanel({
  productId,
  title,
  description,
  children,
}: {
  productId: string
  title: string
  description: string
  children: React.ReactNode
}) {
  const router = useRouter()
  return (
    <Sheet open onOpenChange={(open) => !open && router.push("/catalog", { scroll: false })}>
      <SheetContent side="right" className="w-full overflow-y-auto data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="font-heading text-lg">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
          <Link
            href={`/catalog/products/${productId}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Open as a page
            <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        </SheetHeader>
        <div className="px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
