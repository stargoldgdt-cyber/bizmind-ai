import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { LedgerMonth } from "@/services/ledger/period"
import type { CatalogProduct, Database, ProductCost, SkuAliasMethod } from "@/types/database"

/**
 * Reads for the product master, SKU mapping and product profit (GCC Phase 6),
 * all through the signed-in user's session so Row Level Security decides what
 * can be seen. Money and quantities arrive as exact text.
 */

type Fn = Database["public"]["Functions"]
export type ProductOverviewRow = Fn["catalog_product_overview"]["Returns"][number]
export type SkuQueueRow = Fn["sku_mapping_queue"]["Returns"][number]
export type SkuSetupRowRead = Fn["sku_setup_rows"]["Returns"][number]
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
  method: SkuAliasMethod
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
      .select("id, marketplace_code, raw_sku, status, decided_at, note, method")
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

/**
 * The API returns at most 1,000 rows per request, so a longer list is read in
 * pages. Each reader orders its rows fully, so pages neither overlap nor skip.
 */
const PAGE = 1000

async function everyPage<T>(
  load: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  what: string,
  limit = Number.POSITIVE_INFINITY
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; from < limit; from += PAGE) {
    const to = Math.min(from + PAGE, limit) - 1
    const { data, error } = await load(from, to)
    if (error) throw new Error(`Could not load ${what}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < to - from + 1) break
  }
  return rows
}

/** The SKUs that need a product, largest sales first; `limit` for a first screen. */
export async function getSkuQueue(businessId: string, limit?: number): Promise<SkuQueueRow[]> {
  const supabase = await createClient()
  return everyPage(
    (from, to) => supabase.rpc("sku_mapping_queue", { p_business_id: businessId }).range(from, to),
    "the SKUs to match",
    limit
  )
}

/**
 * One row per marketplace SKU and account: the SKU setup sheet (migration
 * 0045). Unmatched SKUs only, or every SKU for bulk corrections.
 */
export async function getSkuSetupRows(businessId: string, includeMatched: boolean): Promise<SkuSetupRowRead[]> {
  const supabase = await createClient()
  return everyPage(
    (from, to) =>
      supabase.rpc("sku_setup_rows", { p_business_id: businessId, p_include_matched: includeMatched }).range(from, to),
    "your marketplace SKUs"
  )
}

export type SkuSummary = {
  /** Distinct marketplace SKUs in the business's files. */
  skus: number
  recognised: number
  matchedAutomatically: number
  needAttention: number
}

/** How far SKU setup has come, counted in SQL over every SKU (migration 0046). */
export async function getSkuSummary(businessId: string): Promise<SkuSummary> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("sku_setup_summary", { p_business_id: businessId })
  if (error) throw new Error(`Could not count your marketplace SKUs: ${error.message}`)
  const row = data?.[0]
  return {
    skus: row?.skus ?? 0,
    recognised: row?.recognised ?? 0,
    matchedAutomatically: row?.matched_automatically ?? 0,
    needAttention: row?.need_attention ?? 0,
  }
}

export type FileSkuSummary = Fn["ledger_file_sku_summary"]["Returns"][number]

/** The marketplace SKUs in one uploaded file: recognised, or needing setup. */
export async function getFileSkuSummary(sourceFileId: string): Promise<FileSkuSummary | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("ledger_file_sku_summary", { p_source_file_id: sourceFileId })
  if (error) throw new Error(`Could not count the file's SKUs: ${error.message}`)
  return data?.[0] ?? null
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
