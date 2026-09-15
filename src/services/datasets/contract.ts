import type { FieldDef } from "@/services/ingestion/contracts"

/**
 * Dataset targets: the boundary Google Sheets (and CSV) will write through.
 *
 * PHASE 1: BOUNDARY ONLY. No target is registered and the Google Sheets
 * connector does not use this yet -- its transport (sign-in, picker, reading,
 * paging, fingerprints, retries, sync history) is unchanged. Phase 5 moves its
 * target layer from the old ERP entities (ORDERS / PRODUCTS / EXPENSES) onto
 * these datasets (decisions A2-A4).
 *
 * WHAT A DATASET IS NOT
 * ---------------------
 * The ledger. Marketplace financial facts arrive only through a marketplace
 * adapter and `ledger_apply_file()`. A spreadsheet is optional supporting data
 * -- costs, products, expenses -- and can never write a ledger row, a manual
 * adjustment, or a CONFIRMED SKU mapping. The registry refuses all three.
 */

export const DATASET_KEYS = [
  "PRODUCT_MASTER",
  "COGS",
  "OPERATING_EXPENSES",
  "ADVERTISING_EXPENSES",
  "BANK_TRANSACTIONS",
  "SKU_ALIAS_SUGGESTIONS",
] as const

export type DatasetKey = (typeof DATASET_KEYS)[number]

export type DatasetTier = "V1" | "OPTIONAL"

/** The approved plan (ARCHITECTURE_BASELINE.md, section E). */
export const DATASET_PLAN: Record<
  DatasetKey,
  { label: string; tier: DatasetTier; identity: string; writesTo: string; suggestionsOnly: boolean }
> = {
  PRODUCT_MASTER: {
    label: "Product master",
    tier: "V1",
    identity: "Internal SKU",
    writesTo: "products (upsert; archive, never delete)",
    suggestionsOnly: false,
  },
  COGS: {
    label: "COGS per unit",
    tier: "V1",
    identity: "Internal SKU (+ optional effective date)",
    writesTo: "product_costs (a new dated version only when the cost or date changed)",
    suggestionsOnly: false,
  },
  OPERATING_EXPENSES: {
    label: "Operating expenses",
    tier: "V1",
    identity: "Reference",
    writesTo: "expenses (cost class OPERATING)",
    suggestionsOnly: false,
  },
  ADVERTISING_EXPENSES: {
    label: "Advertising expenses",
    tier: "OPTIONAL",
    identity: "Reference",
    writesTo: "expenses (cost class ADVERTISING)",
    suggestionsOnly: false,
  },
  BANK_TRANSACTIONS: {
    label: "Bank transactions",
    tier: "OPTIONAL",
    identity: "Row fingerprint (date, amount, description, reference)",
    writesTo: "bank_transactions",
    suggestionsOnly: false,
  },
  SKU_ALIAS_SUGGESTIONS: {
    label: "SKU mapping suggestions",
    tier: "OPTIONAL",
    identity: "Marketplace + raw SKU",
    writesTo: "sku_aliases, as SUGGESTED only -- confirmation happens inside BizMind",
    suggestionsOnly: true,
  },
}

export type DatasetTarget = {
  key: DatasetKey
  label: string
  /** The field that identifies a record across re-reads of a live sheet. */
  identityField: string
  fields: readonly FieldDef[]
  /** Must match the plan: only SKU_ALIAS_SUGGESTIONS is suggestions-only. */
  suggestionsOnly: boolean
  /** The SQL function that writes this dataset, when it exists. */
  writer: string
}

export type DatasetRegistry = {
  register(target: DatasetTarget): void
  get(key: string): DatasetTarget | null
  list(): readonly DatasetTarget[]
}

export function createDatasetRegistry(): DatasetRegistry {
  const targets = new Map<DatasetKey, DatasetTarget>()

  function isDatasetKey(key: string): key is DatasetKey {
    return (DATASET_KEYS as readonly string[]).includes(key)
  }

  function register(target: DatasetTarget) {
    if (!isDatasetKey(target.key)) {
      throw new Error(
        `"${target.key}" is not a dataset. The ledger, manual adjustments and confirmed ` +
          "SKU mappings are never written from a spreadsheet."
      )
    }
    if (targets.has(target.key)) {
      throw new Error(`A target for ${target.key} is already registered.`)
    }
    if (target.suggestionsOnly !== DATASET_PLAN[target.key].suggestionsOnly) {
      throw new Error(
        `${target.key} must ${DATASET_PLAN[target.key].suggestionsOnly ? "" : "not "}be suggestions-only.`
      )
    }
    if (!target.fields.some((field) => field.key === target.identityField)) {
      throw new Error(`${target.key}: its identity field "${target.identityField}" is not one of its fields.`)
    }
    targets.set(target.key, target)
  }

  return {
    register,
    get: (key) => (isDatasetKey(key) ? targets.get(key) ?? null : null),
    list: () => [...targets.values()],
  }
}

/** The application's dataset targets. Empty until Phase 5. */
export const datasetTargets = createDatasetRegistry()
