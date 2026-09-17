"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient } from "@/lib/supabase/server"

/**
 * The exception path for expenses: an owner or admin says once what one of
 * their own category names means. The database checks membership and role
 * again (B11), versions the rule and audits it.
 */

type Failure = { ok: false; error: string }

async function managingBusiness(): Promise<{ id: string } | Failure> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }
  if (business.role !== "OWNER" && business.role !== "ADMIN") {
    return { ok: false, error: "Only an owner or admin can classify expenses." }
  }
  return { id: business.id }
}

const classifySchema = z.object({
  categoryName: z.string().trim().min(1, "This group has no category name.").max(500),
  categoryCode: z.string().regex(/^[A-Z][A-Z_]{1,40}$/, "Choose a category."),
})

function refresh() {
  revalidatePath("/ledger", "layout")
}

export async function classifyExpenseCategoryAction(input: unknown): Promise<{ ok: true } | Failure> {
  const parsed = classifySchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the category." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { error } = await supabase.rpc("expense_category_classify", {
    p_business_id: business.id,
    p_category_name: parsed.data.categoryName,
    p_category_code: parsed.data.categoryCode,
  })
  if (error) return { ok: false, error: error.message }

  refresh()
  return { ok: true }
}

export async function retireExpenseRuleAction(ruleId: unknown): Promise<{ ok: true } | Failure> {
  const parsed = z.string().uuid().safeParse(ruleId)
  if (!parsed.success) return { ok: false, error: "That classification could not be found." }

  const business = await managingBusiness()
  if ("ok" in business) return business

  const supabase = await createClient()
  const { error } = await supabase.rpc("expense_category_rule_retire", { p_rule_id: parsed.data })
  if (error) return { ok: false, error: error.message }

  refresh()
  return { ok: true }
}
