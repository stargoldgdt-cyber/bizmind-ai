import { Package } from "lucide-react"

/**
 * Stands in for a product photo. BizMind has no product images: marketplace
 * settlement files do not carry them, and nothing is invented to fill the
 * space. If photos are ever added, this is the one place they would go.
 */
export function ProductThumb() {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
      <Package className="size-4" />
    </span>
  )
}
