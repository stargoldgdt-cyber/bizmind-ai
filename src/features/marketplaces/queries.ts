import "server-only"

import { createClient } from "@/lib/supabase/server"
import type { Marketplace, MarketplaceAccount, TaxProfile } from "@/types/database"

/**
 * Marketplace accounts, read through the signed-in user's session (RLS).
 */

export type MarketplaceAccountView = MarketplaceAccount & {
  marketplace_name: string
  adapter_status: Marketplace["adapter_status"]
  vat_registration: TaxProfile["vat_registration"] | null
  tax_treatment: TaxProfile["treatment"] | null
}

export async function listMarketplaces(): Promise<Marketplace[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("marketplaces")
    .select("code, name, adapter_status, created_at")
    .order("name")

  if (error) throw new Error(`Could not load marketplaces: ${error.message}`)
  return data ?? []
}

export async function listMarketplaceAccounts(): Promise<MarketplaceAccountView[]> {
  const supabase = await createClient()

  const [accounts, marketplaces, taxProfiles] = await Promise.all([
    supabase.from("marketplace_accounts").select("*").order("created_at"),
    supabase.from("marketplaces").select("code, name, adapter_status, created_at"),
    supabase.from("tax_profiles").select("*"),
  ])

  if (accounts.error) throw new Error(`Could not load marketplace accounts: ${accounts.error.message}`)
  if (marketplaces.error) throw new Error(`Could not load marketplaces: ${marketplaces.error.message}`)
  if (taxProfiles.error) throw new Error(`Could not load tax profiles: ${taxProfiles.error.message}`)

  const byCode = new Map((marketplaces.data ?? []).map((m) => [m.code, m]))
  const taxByAccount = new Map((taxProfiles.data ?? []).map((t) => [t.marketplace_account_id, t]))

  return (accounts.data ?? []).map((account) => ({
    ...account,
    marketplace_name: byCode.get(account.marketplace_code)?.name ?? account.marketplace_code,
    adapter_status: byCode.get(account.marketplace_code)?.adapter_status ?? "CONTRACT_ONLY",
    vat_registration: taxByAccount.get(account.id)?.vat_registration ?? null,
    tax_treatment: taxByAccount.get(account.id)?.treatment ?? null,
  }))
}
