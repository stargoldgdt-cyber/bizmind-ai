import { amazonFlatFileV2Adapter } from "./amazon/flat-file-v2"
import { noonAdapter } from "./noon/adapter"
import { marketplaceAdapters } from "./registry"

/**
 * The adapters BizMind ships.
 *
 *   GCC Phase 2: Amazon Flat File V2
 *   GCC Phase 5: noon Transaction View + Invoices and Credit Notes
 *
 * Carrefour stays a contract until its capability is verified (A15, B13).
 *
 * Registration is guarded so a module re-evaluated during development does not
 * trip the registry's duplicate check.
 */
for (const adapter of [amazonFlatFileV2Adapter, noonAdapter]) {
  if (!marketplaceAdapters.get(adapter.marketplace)) {
    marketplaceAdapters.register(adapter)
  }
}

export { marketplaceAdapters }
