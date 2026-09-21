import "server-only"

import { createClient } from "@/lib/supabase/server"

/**
 * After a marketplace file is recorded: match every unmatched SKU that is
 * identical to a known one, spaces, dashes and capitals aside (migration 0045,
 * owner decision 2026-09-18). It never replaces a mapping or re-makes a
 * rejected one. Runs through the user's own session. Best effort: a failure
 * is logged and the upload still succeeds.
 */
export async function matchIdenticalSkus(businessId: string): Promise<number> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc("sku_auto_match", { p_business_id: businessId })
  if (error) {
    console.error("[catalog] automatic SKU matching failed", error.message)
    return 0
  }
  return data ?? 0
}
