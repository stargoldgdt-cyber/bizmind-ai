import type { EntityDef, Mapping } from "./contracts"

/**
 * Suggests a column mapping from the file's headers.
 *
 * A suggestion is only ever a starting point — the user confirms every field
 * before anything is imported. Nothing is mapped on their behalf silently,
 * because a mis-mapped cost column produces a wrong margin that looks right.
 */

/** Lowercase, strip punctuation, collapse whitespace. */
function canonical(header: string): string {
  return header
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function suggestMapping(entity: EntityDef, headers: string[]): Mapping {
  const mapping: Mapping = {}
  const taken = new Set<string>()

  const normalized = headers.map((h) => ({ raw: h, key: canonical(h) }))

  // Exact alias matches first, so a precise header always beats a loose one.
  for (const field of entity.fields) {
    const aliases = new Set([canonical(field.label), ...field.aliases.map(canonical)])

    const exact = normalized.find((h) => !taken.has(h.raw) && aliases.has(h.key))
    if (exact) {
      mapping[field.key] = exact.raw
      taken.add(exact.raw)
    }
  }

  // Then a conservative contains-match for anything still unmapped.
  for (const field of entity.fields) {
    if (mapping[field.key]) continue

    const aliases = [canonical(field.label), ...field.aliases.map(canonical)].filter(
      // Very short aliases such as "id" match far too much to use loosely.
      (a) => a.length >= 4
    )

    const partial = normalized.find(
      (h) => !taken.has(h.raw) && aliases.some((a) => h.key === a || h.key.includes(a))
    )

    if (partial) {
      mapping[field.key] = partial.raw
      taken.add(partial.raw)
    }
  }

  return mapping
}
