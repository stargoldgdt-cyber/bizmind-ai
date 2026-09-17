import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { LedgerMonth } from "@/services/ledger/period"
import type { CatalogProduct, Database, ProductCost } from "@/types/database"

/**
 * Reads for the product master, SKU mapping and product profit (GCC Phase 6),
 * all through the signed-in user's session so Row Level Security decides what
 * can be seen. Money and quantities arrive as exact text.
 */

type Fn = Database["public"]["Functions"]
export type ProductOverviewRow = Fn["catalog_product_overview"]["Returns"][number]
export type SkuQueueRow = Fn["sku_mapping_queue"]["Returns"][number]
export type ProductProfitRow = Fn["pnl_by_product"]["Returns"][number]

export async function listProductOverview(businessId: string): Promise<ProductOverviewRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("catalog_product_overview", { p_business_id: businessId })
  if (error) throw new Error(`Could not load your products: ${error.message}`)
  return data ?? []
}

export type ProductChoice = Pick<CatalogProduct, "id" | "name" | "sku_code">

/** Active products, for choosing one to map a SKU to. */
export async function listActiveProducts(businessId: string): Promise<ProductChoice[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("catalog_products")
    .select("id, name, sku_code")
    .eq("business_id", businessId)
    .eq("status", "ACTIVE")
    .order("name")
  if (error) throw new Error(`Could not load your products: ${error.message}`)
  return (data ?? []) as ProductChoice[]
}

export type MappedSku = {
  id: string
  marketplace_code: string
  raw_sku: string
  status: "CONFIRMED" | "REJECTED"
  decided_at: string
  note: string | null
}

export type ProductDetail = {
  product: CatalogProduct
  costs: ProductCost[]
  skus: MappedSku[]
}

export async function getProductDetail(businessId: string, productId: string): Promise<ProductDetail | null> {
  const supabase = await createClient()
  const { data: product, error } = await supabase
    .from("catalog_products")
    .select("*")
    .eq("business_id", businessId)
    .eq("id", productId)
    .maybeSingle()
  if (error) throw new Error(`Could not load the product: ${error.message}`)
  if (!product) return null

  const [costs, skus] = await Promise.all([
    supabase
      .from("product_costs")
      .select("*")
      .eq("product_id", productId)
      .order("currency")
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("sku_aliases")
      .select("id, marketplace_code, raw_sku, status, decided_at, note")
      .eq("product_id", productId)
      .order("status")
      .order("marketplace_code")
      .order("raw_sku"),
  ])
  if (costs.error) throw new Error(`Could not load the product's costs: ${costs.error.message}`)
  if (skus.error) throw new Error(`Could not load the product's SKUs: ${skus.error.message}`)

  return {
    product: product as CatalogProduct,
    costs: (costs.data ?? []) as ProductCost[],
    skus: (skus.data ?? []) as MappedSku[],
  }
}

export async function getSkuQueue(businessId: string): Promise<SkuQueueRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("sku_mapping_queue", { p_business_id: businessId })
  if (error) throw new Error(`Could not load the SKUs to match: ${error.message}`)
  return data ?? []
}

/** The currencies the business sells in: those of its marketplace accounts. */
export async function listBusinessCurrencies(businessId: string): Promise<string[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("currency")
    .eq("business_id", businessId)
  if (error) throw new Error(`Could not load your currencies: ${error.message}`)
  return [...new Set((data ?? []).map((row: { currency: string }) => row.currency))].sort()
}

/** Product profit for one account, or every account in a currency. */
export async function getProductProfit(
  businessId: string,
  scope: { accountId: string } | { currency: string },
  month: LedgerMonth
): Promise<ProductProfitRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("pnl_by_product", {
    p_from: month.from,
    p_to: month.to,
    p_account_id: "accountId" in scope ? scope.accountId : null,
    p_business_id: businessId,
  })
  if (error) throw new Error(`Could not load product profit: ${error.message}`)
  const rows = data ?? []
  return "currency" in scope ? rows.filter((row) => row.currency === scope.currency) : rows
}
