import { amazonAdapter } from "./amazon/adapter"
import { noonAdapter } from "./noon/adapter"
import { marketplaceAdapters } from "./registry"

/**
 * The adapters BizMind ships.
 *
 *   GCC Phase 2: Amazon Flat File V2
 *   GCC Phase 5: noon Transaction View + Invoices and Credit Notes
 *   GCC Phase 9 follow-up: Amazon VAT tax invoice / credit note PDFs (optional)
 *
 * Carrefour stays a contract until its capability is verified (A15, B13).
 *
 * Registration is guarded so a module re-evaluated during development does not
 * trip the registry's duplicate check.
 */
for (const adapter of [amazonAdapter, noonAdapter]) {
  if (!marketplaceAdapters.get(adapter.marketplace)) {
    marketplaceAdapters.register(adapter)
  }
}

export { marketplaceAdapters }
