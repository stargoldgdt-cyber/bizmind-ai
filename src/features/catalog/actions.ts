"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient } from "@/lib/supabase/server"
import { UNIT_COST_PATTERN } from "@/services/catalog/sku"

/**
 * Products, SKU mappings and dated costs (GCC Phase 6).
 *
 * The business comes from the session. Every database function checks
 * membership and the OWNER/ADMIN role again (B11) and writes the audit log;
 * the checks here only give a clear message sooner.
 */

type Failure = { ok: false; error: string }

async function managingBusiness(): Promise<{ id: string } | Failure> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }
  if (business.role !== "OWNER" && business.role !== "ADMIN") {
    return { ok: false, error: "Only an owner or admin can manage products, SKU matches and costs." }
  }
  return { id: business.id }
}

const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `Keep the ${label} under ${max} characters.`).optional()

const productSchema = z.object({
  name: z.string().trim().min(1, "Give the product a name.").max(200, "Keep the name under 200 characters."),
  skuCode: optionalText(120, "SKU code"),
  category: optionalText(80, "category"),
  brand: optionalText(80, "brand"),
})

function refresh() {
  revalidatePath("/catalog", "layout")
  revalidatePath("/ledger", "layout")
}

export async function createProductAction(input: unknown): Promise<{ ok: true; id: string } | Failure> {
  const parsed = productSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the product." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("catalog_product_create", {
    p_business_id: business.id,
    p_name: parsed.data.name,
    p_sku_code: parsed.data.skuCode || null,
    p_category: parsed.data.category || null,
    p_brand: parsed.data.brand || null,
  })
  if (error || !data) return { ok: false, error: error?.message ?? "The product could not be added." }

  refresh()
  return { ok: true, id: data }
}

const updateSchema = productSchema.extend({
  productId: z.string().uuid(),
  status: z.enum(["ACTIVE", "ARCHIVED"]),
})

export async function updateProductAction(input: unknown): Promise<{ ok: true } | Failure> {
  const parsed = updateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the product." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  // An empty optional field is sent as "" so the database clears it.
  const { error } = await supabase.rpc("catalog_product_update", {
    p_product_id: parsed.data.productId,
    p_name: parsed.data.name,
    p_sku_code: parsed.data.skuCode ?? "",
    p_category: parsed.data.category ?? "",
    p_brand: parsed.data.brand ?? "",
    p_status: parsed.data.status,
  })
  if (error) return { ok: false, error: error.message }

  refresh()
  return { ok: true }
}

const decisionSchema = z.object({
  marketplaceCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  rawSku: z.string().min(1).max(200),
  productId: z.string().uuid("Choose a product."),
  decision: z.enum(["CONFIRMED", "REJECTED"]),
})

export async function decideSkuAction(input: unknown): Promise<{ ok: true } | Failure> {
  const parsed = decisionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the match." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { error } = await supabase.rpc("sku_alias_decide", {
    p_business_id: business.id,
    p_marketplace_code: parsed.data.marketplaceCode,
    p_raw_sku: parsed.data.rawSku,
    p_product_id: parsed.data.productId,
    p_decision: parsed.data.decision,
  })
  if (error) return { ok: false, error: error.message }

  refresh()
  return { ok: true }
}

/** Create a product named after a marketplace SKU and match the SKU to it. */
export async function createProductFromSkuAction(input: unknown): Promise<{ ok: true } | Failure> {
  const parsed = z
    .object({
      marketplaceCode: decisionSchema.shape.marketplaceCode,
      rawSku: decisionSchema.shape.rawSku,
      name: productSchema.shape.name,
    })
    .safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the product." }

  const created = await createProductAction({ name: parsed.data.name, skuCode: parsed.data.rawSku.slice(0, 120) })
  if (!created.ok) return created

  return decideSkuAction({
    marketplaceCode: parsed.data.marketplaceCode,
    rawSku: parsed.data.rawSku,
    productId: created.id,
    decision: "CONFIRMED",
  })
}

export async function removeSkuMatchAction(aliasId: unknown): Promise<{ ok: true } | Failure> {
  const parsed = z.string().uuid().safeParse(aliasId)
  if (!parsed.success) return { ok: false, error: "That match could not be found." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { error } = await supabase.rpc("sku_alias_remove", { p_alias_id: parsed.data })
  if (error) return { ok: false, error: error.message }

  refresh()
  return { ok: true }
}

const costSchema = z.object({
  productId: z.string().uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Choose a currency."),
  unitCost: z.string().trim().regex(UNIT_COST_PATTERN, "Enter the cost as a plain number, for example 42.50."),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date the cost applies from."),
  note: optionalText(300, "note"),
})

export async function addProductCostAction(input: unknown): Promise<{ ok: true } | Failure> {
  const parsed = costSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the cost." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { error } = await supabase.rpc("product_cost_add", {
    p_product_id: parsed.data.productId,
    p_currency: parsed.data.currency,
    p_unit_cost: parsed.data.unitCost,
    p_effective_from: parsed.data.effectiveFrom,
    p_note: parsed.data.note || null,
  })
  if (error) return { ok: false, error: error.message }

  refresh()
  return { ok: true }
}

export async function retireProductCostAction(input: unknown): Promise<{ ok: true } | Failure> {
  const parsed = z
    .object({ costId: z.string().uuid(), reason: optionalText(300, "reason") })
    .safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That cost could not be found." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { error } = await supabase.rpc("product_cost_retire", {
    p_cost_id: parsed.data.costId,
    p_reason: parsed.data.reason || null,
  })
  if (error) return { ok: false, error: error.message }

  refresh()
  return { ok: true }
}
