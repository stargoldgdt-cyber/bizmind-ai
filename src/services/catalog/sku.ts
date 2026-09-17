/**
 * SKU helpers for the product master (GCC Phase 6).
 *
 * `normalizeSku` mirrors `public.sku_normalize()`: letters and digits only,
 * upper case. It is used ONLY to suggest a mapping; a person confirms every
 * one (A10). Two SKUs that normalise alike are never merged automatically.
 */
export function normalizeSku(value: string | null | undefined): string {
  return (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase()
}

/** A unit cost as the owner types it: a plain non-negative number, up to 4 decimals. */
export const UNIT_COST_PATTERN = /^[0-9]{1,16}(\.[0-9]{1,4})?$/

export type SuggestionReason = "SAME_SKU_CODE" | "MAPPED_ON_OTHER_MARKETPLACE"

export const SUGGESTION_REASON_LABEL: Record<SuggestionReason, string> = {
  SAME_SKU_CODE: "Same SKU code as the product",
  MAPPED_ON_OTHER_MARKETPLACE: "Same SKU is mapped on another marketplace",
}

export type CogsStatus = "COSTED" | "PARTLY_COSTED" | "NO_COST" | "NO_PRODUCT" | "NOT_APPLICABLE"

export type GrossProfitReason = "SKU_NOT_MAPPED" | "COST_MISSING"
