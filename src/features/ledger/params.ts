/**
 * URL helpers for the ledger screens. Filters live in the URL, so every view
 * can be bookmarked, shared with a teammate and opened in a new tab.
 */

export type SearchParams = Record<string, string | string[] | undefined>

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function ledgerHref(path: string, params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") query.set(key, String(value))
  }
  const encoded = query.toString()
  return encoded ? `${path}?${encoded}` : path
}
