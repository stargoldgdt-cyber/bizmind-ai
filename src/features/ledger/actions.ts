"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient } from "@/lib/supabase/server"
import type { Database } from "@/types/database"

/**
 * The exception path: an owner or admin classifies a marketplace code BizMind
 * does not recognise, for their own business (B2 amended).
 *
 * The business comes from the session. The database checks membership and
 * role again, refuses codes BizMind already classifies or that do not appear
 * in the business's files, versions every change and audits it.
 */

const codeSchema = z.object({
  marketplaceCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  formatId: z.string().min(1).max(120),
  matchKey: z.string().min(1).max(300),
})

const classifySchema = codeSchema.extend({
  category: z.string().regex(/^[A-Z][A-Z_]{1,40}$/, "Choose a category."),
  subcategory: z.string().trim().min(1, "Give the line a short name.").max(80, "Keep the name under 80 characters."),
  note: z.string().trim().max(200, "Keep the note under 200 characters.").optional(),
})

export type ImpactRow = Database["public"]["Functions"]["classification_rule_impact"]["Returns"][number]

type Failure = { ok: false; error: string }

async function managingBusiness(): Promise<{ id: string } | Failure> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }
  if (business.role !== "OWNER" && business.role !== "ADMIN") {
    return { ok: false, error: "Only an owner or admin can classify a marketplace code." }
  }
  return { id: business.id }
}

/** What classifying a code would move: its lines per account and month. */
export async function previewClassificationAction(
  input: unknown
): Promise<{ ok: true; rows: ImpactRow[] } | Failure> {
  const parsed = codeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "That code could not be read." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("classification_rule_impact", {
    p_business_id: business.id,
    p_marketplace_code: parsed.data.marketplaceCode,
    p_format_id: parsed.data.formatId,
    p_match_key: parsed.data.matchKey,
  })

  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: data ?? [] }
}

export async function classifyCodeAction(input: unknown): Promise<{ ok: true } | Failure> {
  const parsed = classifySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the classification." }
  }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { error } = await supabase.rpc("classification_rule_classify", {
    p_business_id: business.id,
    p_marketplace_code: parsed.data.marketplaceCode,
    p_format_id: parsed.data.formatId,
    p_match_key: parsed.data.matchKey,
    p_category: parsed.data.category,
    p_subcategory: parsed.data.subcategory,
    p_note: parsed.data.note || null,
  })

  if (error) return { ok: false, error: error.message }

  revalidatePath("/ledger", "layout")
  return { ok: true }
}

/** Undo a business's own classification: the code becomes Unknown again. */
export async function retireClassificationAction(ruleId: unknown): Promise<{ ok: true } | Failure> {
  const parsed = z.string().uuid().safeParse(ruleId)
  if (!parsed.success) return { ok: false, error: "That classification could not be found." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { error } = await supabase.rpc("classification_rule_retire", { p_rule_id: parsed.data })
  if (error) return { ok: false, error: error.message }

  revalidatePath("/ledger", "layout")
  return { ok: true }
}
