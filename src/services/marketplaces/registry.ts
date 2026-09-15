import type { DetectSample, FormatDescriptor, MarketplaceAdapter } from "./contract"
import { isCustomerDataColumn } from "./customer-data"

/**
 * The adapter registry.
 *
 * PHASE 1 REGISTERS NOTHING. Amazon arrives in Phase 2, noon once real sample
 * files exist (A17), Carrefour only when its capability is verified (A15).
 *
 * Registration refuses anything that would let a bad format in quietly: a
 * duplicate marketplace, a format id used twice, a required header the format
 * does not allow, or an allowed column that looks like customer data.
 */

export type DetectOutcome =
  | { kind: "match"; adapter: MarketplaceAdapter; format: FormatDescriptor; confidence: "exact" | "likely" }
  | { kind: "reject"; formatId: string; message: string }
  /** Two formats claim the file. Guessing between them would be guessing a meaning. */
  | { kind: "ambiguous"; formatIds: string[] }
  | { kind: "unknown" }

export type AdapterRegistry = {
  register(adapter: MarketplaceAdapter): void
  get(marketplace: string): MarketplaceAdapter | null
  list(): readonly MarketplaceAdapter[]
  detect(sample: DetectSample): DetectOutcome
}

const MARKETPLACE_CODE = /^[A-Z][A-Z0-9_]{1,31}$/

export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<string, MarketplaceAdapter>()
  const formatIds = new Set<string>()

  function register(adapter: MarketplaceAdapter) {
    if (!MARKETPLACE_CODE.test(adapter.marketplace)) {
      throw new Error(`"${adapter.marketplace}" is not a marketplace code.`)
    }
    if (adapters.has(adapter.marketplace)) {
      throw new Error(`An adapter for ${adapter.marketplace} is already registered.`)
    }

    const seen = new Set<string>()
    for (const format of adapter.formats) {
      if (formatIds.has(format.id) || seen.has(format.id)) {
        throw new Error(`The format id "${format.id}" is already registered.`)
      }
      seen.add(format.id)

      const customerColumns = format.allowedColumns.filter(isCustomerDataColumn)
      if (customerColumns.length > 0) {
        throw new Error(
          `Format "${format.id}" allows customer-data columns (${customerColumns.join(", ")}). ` +
            "Customer details are never stored."
        )
      }

      const allowed = new Set(format.allowedColumns)
      const missing = format.requiredHeaders.filter((header) => !allowed.has(header))
      if (missing.length > 0) {
        throw new Error(
          `Format "${format.id}" requires headers it does not allow: ${missing.join(", ")}.`
        )
      }
    }

    for (const id of seen) formatIds.add(id)
    adapters.set(adapter.marketplace, adapter)
  }

  function detect(sample: DetectSample): DetectOutcome {
    const matches: { adapter: MarketplaceAdapter; format: FormatDescriptor; confidence: "exact" | "likely" }[] = []

    for (const adapter of adapters.values()) {
      const result = adapter.detect(sample)
      if (result.kind === "reject") return result
      if (result.kind === "match") {
        const format = adapter.formats.find((candidate) => candidate.id === result.formatId)
        if (!format) {
          throw new Error(
            `${adapter.marketplace} detected "${result.formatId}", which it does not declare.`
          )
        }
        matches.push({ adapter, format, confidence: result.confidence })
      }
    }

    if (matches.length === 0) return { kind: "unknown" }
    if (matches.length > 1) {
      return { kind: "ambiguous", formatIds: matches.map((match) => match.format.id) }
    }
    return { kind: "match", ...matches[0] }
  }

  return {
    register,
    get: (marketplace) => adapters.get(marketplace) ?? null,
    list: () => [...adapters.values()],
    detect,
  }
}

/** The application's registry. Empty in Phase 1. */
export const marketplaceAdapters = createAdapterRegistry()
