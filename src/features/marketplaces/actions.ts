"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient } from "@/lib/supabase/server"

/**
 * Creating a marketplace account.
 *
 * The business is the one in the session; the database checks that the caller
 * is its OWNER (decision B11: configuration belongs to the owner) and writes
 * the audit entry. A tampered request can at most choose a different label.
 */

const accountSchema = z.object({
  marketplaceCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
  label: z.string().trim().min(1, "Give the account a name.").max(80),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, "Choose a country."),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "Choose a currency."),
  externalSellerRef: z.string().trim().max(120).optional(),
})

export type CreateAccountResult = { ok: true; id: string } | { ok: false; error: string }

export async function createMarketplaceAccountAction(input: unknown): Promise<CreateAccountResult> {
  const parsed = accountSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the account details." }
  }

  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("marketplace_account_create", {
    p_business_id: business.id,
    p_marketplace_code: parsed.data.marketplaceCode,
    p_label: parsed.data.label,
    p_country: parsed.data.country.toUpperCase(),
    p_currency: parsed.data.currency.toUpperCase(),
    p_external_seller_ref: parsed.data.externalSellerRef || null,
  })

  // The database's own wording is written for the owner ("Only an owner can
  // add a marketplace account.", "This marketplace account already exists.").
  if (error) return { ok: false, error: error.message }

  revalidatePath("/marketplaces")
  revalidatePath("/imports/settlement")
  return { ok: true, id: data }
}

const inputVatSchema = z.object({
  accountId: z.string().uuid(),
  treatment: z.enum(["UNKNOWN", "RECOVERABLE", "NON_RECOVERABLE"]),
})

export type SetInputVatResult = { ok: true } | { ok: false; error: string }

/**
 * The account's VAT setting for marketplace fees (decision B1). The database
 * checks that the caller owns the account's business and records the change
 * in the audit log; ledger lines never change when this does.
 */
export async function setInputVatTreatmentAction(input: unknown): Promise<SetInputVatResult> {
  const parsed = inputVatSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Choose Recoverable, Non-recoverable or Unknown." }

  const supabase = await createClient()
  const { error } = await supabase.rpc("tax_profile_set_input_vat", {
    p_account_id: parsed.data.accountId,
    p_treatment: parsed.data.treatment,
  })

  if (error) return { ok: false, error: error.message }

  revalidatePath("/marketplaces")
  return { ok: true }
}
