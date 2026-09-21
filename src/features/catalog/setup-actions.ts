"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { getSkuSetupRows } from "@/features/catalog/queries"
import { createClient } from "@/lib/supabase/server"
import { UNIT_COST_PATTERN } from "@/services/catalog/sku"
import { checkSkuSetup, type SkuSetupIssue, type SkuSetupRow } from "@/services/catalog/sku-setup"
import { readSkuSetupWorkbook } from "@/services/catalog/sku-setup-workbook"
import type { Database, Json } from "@/types/database"

/**
 * SKU setup (migration 0045): the one-sheet Excel and the inline "Save &
 * Match". Both end in `sku_setup_apply()`, so a cost follows the same rules
 * whichever way it is entered: a product's first cost applies from its first
 * sale, a changed cost from today, and history is never rewritten.
 *
 * The business comes from the session; the database checks OWNER/ADMIN again.
 */

type Failure = { ok: false; error: string }
export type SkuSetupResult = Database["public"]["Functions"]["sku_setup_apply"]["Returns"]

/** A sheet row names its product by Product SKU; an inline match may pick one by id. */
type ApplyRow = Omit<SkuSetupRow, "product_sku"> & ({ product_sku: string } | { product_id: string })

async function managingBusiness(): Promise<{ id: string } | Failure> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }
  if (business.role !== "OWNER" && business.role !== "ADMIN") {
    return { ok: false, error: "Only an owner or admin can set up SKUs and costs." }
  }
  return { id: business.id }
}

function refresh() {
  revalidatePath("/catalog", "layout")
  revalidatePath("/ledger", "layout")
  revalidatePath("/overview")
}

async function apply(businessId: string, rows: ApplyRow[]): Promise<{ ok: true; result: SkuSetupResult } | Failure> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("sku_setup_apply", {
    p_business_id: businessId,
    p_rows: rows as unknown as Json,
  })
  if (error || !data) return { ok: false, error: error?.message ?? "The setup could not be applied." }
  refresh()
  return { ok: true, result: data }
}

/* ---- Excel: check first, then apply --------------------------------------- */

export type SkuSetupPreview = {
  ok: true
  rows: SkuSetupRow[]
  issues: SkuSetupIssue[]
  leftBlank: number
  products: number
}

export async function previewSkuSetupAction(formData: FormData): Promise<SkuSetupPreview | Failure> {
  const business = await managingBusiness()
  if ("ok" in business) return business

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the filled Excel file." }
  if (!file.name.toLowerCase().endsWith(".xlsx")) return { ok: false, error: "Upload the .xlsx file downloaded from BizMind." }
  if (file.size > 8 * 1024 * 1024) return { ok: false, error: "That file is larger than 8 MB." }

  const read = await readSkuSetupWorkbook(Buffer.from(await file.arrayBuffer()))
  if (!read.ok) return read

  const known = new Set(
    (await getSkuSetupRows(business.id, true)).map((r) => `${r.marketplace_code}|${r.raw_sku}`)
  )
  const checked = checkSkuSetup(read.records, known)
  return { ok: true, ...checked }
}

const setupRowSchema = z.object({
  row: z.number().int().min(1).max(999_999),
  marketplace_code: z.string().regex(/^[A-Z]{2,20}$/),
  raw_sku: z.string().min(1).max(200),
  product_sku: z.string().trim().min(1).max(120),
  product_name: z.string().trim().max(200).nullable(),
  unit_cost: z.string().regex(UNIT_COST_PATTERN).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
})

export async function applySkuSetupAction(input: unknown): Promise<{ ok: true; result: SkuSetupResult } | Failure> {
  const parsed = z.array(setupRowSchema).min(1, "There are no rows to apply.").max(5000).safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the sheet again." }

  const business = await managingBusiness()
  if ("ok" in business) return business
  return apply(business.id, parsed.data)
}

/* ---- inline: one SKU at a time ---------------------------------------------- */

const inlineSchema = z
  .object({
    marketplaceCode: z.string().regex(/^[A-Z]{2,20}$/),
    rawSku: z.string().min(1).max(200),
    productId: z.string().uuid().optional(),
    newProductSku: z.string().trim().max(120, "A Product SKU has at most 120 characters.").optional(),
    newProductName: z.string().trim().max(200, "A product name has at most 200 characters.").optional(),
    unitCost: z
      .string()
      .trim()
      .refine((v) => v === "" || UNIT_COST_PATTERN.test(v), "Enter the cost as a plain number, for example 120 or 42.50.")
      .optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  })
  .refine((v) => Boolean(v.productId) || Boolean(v.newProductSku), "Choose a product, or give the new product a SKU.")
  .refine((v) => !v.unitCost || Boolean(v.currency), "A cost needs its currency.")

export async function saveAndMatchAction(input: unknown): Promise<{ ok: true; result: SkuSetupResult } | Failure> {
  const parsed = inlineSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the product and cost." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const v = parsed.data
  const cost = v.unitCost ? v.unitCost : null
  const row: ApplyRow = {
    row: 1,
    marketplace_code: v.marketplaceCode,
    raw_sku: v.rawSku,
    ...(v.productId ? { product_id: v.productId } : { product_sku: v.newProductSku ?? "" }),
    product_name: v.newProductName || null,
    unit_cost: cost,
    currency: cost ? (v.currency ?? null) : null,
  }
  return apply(business.id, [row])
}
