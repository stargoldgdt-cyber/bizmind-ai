import { redirect } from "next/navigation"

/**
 * SKU matching moved onto Products and costs (migration 0045): one page for
 * products, SKU mappings and costs. Old links and bookmarks land there.
 */
export default function SkuMappingPage() {
  redirect("/catalog#needs-attention")
}
