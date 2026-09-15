import { amazonFlatFileV2Adapter } from "./amazon/flat-file-v2"
import { marketplaceAdapters } from "./registry"

/**
 * The adapters BizMind ships.
 *
 * GCC Phase 2: Amazon Flat File V2 only. noon waits for its adapter phase (its
 * sample files have arrived, but its mapping is not built yet); Carrefour stays
 * a contract until its capability is verified (A15).
 *
 * Registration is guarded so a module re-evaluated during development does not
 * trip the registry's duplicate check.
 */
if (!marketplaceAdapters.get(amazonFlatFileV2Adapter.marketplace)) {
  marketplaceAdapters.register(amazonFlatFileV2Adapter)
}

export { marketplaceAdapters }
