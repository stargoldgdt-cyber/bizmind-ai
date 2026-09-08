"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient } from "@/lib/supabase/server"
import type {
  EntityKey,
  ImportOptions,
  Mapping,
  RawRecord,
  ValidationResult,
} from "@/services/ingestion/contracts"
import { ENTITIES } from "@/services/ingestion/entities"
import { validate } from "@/services/ingestion/validate"

/**
 * Import server actions.
 *
 * Both preview and commit re-run the SAME validation from the stored raw rows.
 * The client never supplies the data to be written — only the mapping and the
 * options. That means a tampered request can change how a file is interpreted,
 * but never what file is imported or into which business.
 */

const optionsSchema = z.object({
  dateFormat: z.enum(["auto", "DMY", "MDY", "YMD"]),
  decimalSeparator: z.enum([".", ","]),
  source: z.enum([
    "WEBSITE",
    "SHOPIFY",
    "WOOCOMMERCE",
    "AMAZON",
    "DARAZ",
    "EBAY",
    "FACEBOOK",
    "INSTAGRAM",
    "POS",
    "MANUAL",
    "OTHER",
  ]),
  channelId: z.string().uuid().nullable().optional(),
  acknowledgedWarnings: z.boolean().optional(),
})

const mappingSchema = z.record(z.string(), z.string())

/**
 * Zod types a record's values as possibly undefined. Drop empty entries so the
 * rest of the pipeline can rely on "present in the mapping" meaning "mapped".
 */
function toMapping(input: Record<string, string | undefined>): Mapping {
  const out: Mapping = {}
  for (const [field, column] of Object.entries(input)) {
    if (column && column.trim() !== "") out[field] = column
  }
  return out
}

export type PreviewResult =
  | { ok: true; validation: ValidationResult; preview: unknown[] }
  | { ok: false; error: string }

export type CommitResult =
  | { ok: true; summary: Record<string, number>; batchId: string }
  | { ok: false; error: string }

/** Loads a batch. RLS means this only finds batches in the caller's business. */
async function loadBatch(batchId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("import_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle()

  if (error) return { ok: false as const, error: error.message }
  if (!data) return { ok: false as const, error: "That import could not be found." }
  return { ok: true as const, batch: data }
}

async function runValidation(
  batch: { entity: string; raw_rows: unknown },
  mapping: Mapping,
  options: ImportOptions,
  businessCurrency: string
) {
  const entity = ENTITIES[batch.entity as EntityKey]
  const rows = (batch.raw_rows ?? []) as RawRecord[]
  return validate(entity, rows, mapping, options, businessCurrency)
}

export async function previewImportAction(
  batchId: string,
  rawMapping: unknown,
  rawOptions: unknown
): Promise<PreviewResult> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  const parsedMapping = mappingSchema.safeParse(rawMapping)
  const parsedOptions = optionsSchema.safeParse(rawOptions)

  if (!parsedMapping.success) return { ok: false, error: "The column mapping is not valid." }
  if (!parsedOptions.success) return { ok: false, error: "The import settings are not valid." }

  const loaded = await loadBatch(batchId)
  if (!loaded.ok) return { ok: false, error: loaded.error }

  const mapping = toMapping(parsedMapping.data)

  const validation = await runValidation(
    loaded.batch,
    mapping,
    parsedOptions.data,
    business.currency
  )

  const supabase = await createClient()

  // Record what was decided, so the preview the user saw is reconstructable.
  await supabase
    .from("import_batches")
    .update({
      mapping,
      options: parsedOptions.data,
      status: validation.blocked ? "DRAFT" : "READY",
      rows_valid: validation.validRowCount,
      rows_failed: validation.failedRowCount,
    })
    .eq("id", batchId)

  // Replace previous issues rather than appending, so re-previewing after a
  // mapping change does not leave stale problems on screen.
  await supabase.from("import_issues").delete().eq("batch_id", batchId)

  if (validation.issues.length > 0) {
    await supabase.from("import_issues").insert(
      validation.issues.slice(0, 500).map((issue) => ({
        business_id: business.id,
        batch_id: batchId,
        row_number: issue.rowNumber,
        severity: issue.severity,
        field: issue.field ?? null,
        message: issue.message,
        raw_value: issue.rawValue ?? null,
      }))
    )
  }

  return { ok: true, validation, preview: validation.rows.slice(0, 10) }
}

export async function commitImportAction(
  batchId: string,
  rawMapping: unknown,
  rawOptions: unknown
): Promise<CommitResult> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  if (business.role === "VIEWER") {
    return { ok: false, error: "Your role can view data but not import it." }
  }

  const parsedMapping = mappingSchema.safeParse(rawMapping)
  const parsedOptions = optionsSchema.safeParse(rawOptions)
  if (!parsedMapping.success) return { ok: false, error: "The column mapping is not valid." }
  if (!parsedOptions.success) return { ok: false, error: "The import settings are not valid." }

  const loaded = await loadBatch(batchId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  if (loaded.batch.status === "COMPLETED") {
    return { ok: false, error: "This import has already been applied." }
  }

  const mapping = toMapping(parsedMapping.data)

  // Validate again from the stored rows. The preview's result is never trusted
  // as an input — that would let a crafted request write unvalidated data.
  const validation = await runValidation(
    loaded.batch,
    mapping,
    parsedOptions.data,
    business.currency
  )

  if (validation.blocked) {
    return { ok: false, error: validation.blockedReason ?? "This file cannot be imported." }
  }

  if (validation.missingRecommended.length > 0 && !parsedOptions.data.acknowledgedWarnings) {
    return {
      ok: false,
      error:
        "Some recommended columns are not mapped. Confirm you understand which " +
        "figures will be incomplete before importing.",
    }
  }

  const supabase = await createClient()

  // Resolve the channel for order imports, creating it on first use so orders
  // are always attributable. Channel profitability depends on it.
  let channelId: string | null = parsedOptions.data.channelId ?? null

  if (loaded.batch.entity === "ORDERS" && !channelId) {
    const label = channelLabel(parsedOptions.data.source)
    const { data: existing } = await supabase
      .from("channels")
      .select("id")
      .eq("business_id", business.id)
      .eq("name", label)
      .maybeSingle()

    if (existing) {
      channelId = existing.id
    } else {
      const { data: created, error: channelError } = await supabase
        .from("channels")
        .insert({
          business_id: business.id,
          name: label,
          type: parsedOptions.data.source,
        })
        .select("id")
        .single()

      if (channelError) {
        return { ok: false, error: `The sales channel could not be created: ${channelError.message}` }
      }
      channelId = created.id
    }
  }

  const { error: prepError } = await supabase
    .from("import_batches")
    .update({
      mapping,
      options: parsedOptions.data,
      source: parsedOptions.data.source,
      channel_id: channelId,
      rows_valid: validation.validRowCount,
      rows_failed: validation.failedRowCount,
    })
    .eq("id", batchId)

  if (prepError) return { ok: false, error: `The import could not be prepared: ${prepError.message}` }

  // One call, one transaction. A failure part-way leaves nothing behind.
  const fn =
    loaded.batch.entity === "ORDERS"
      ? "import_apply_orders"
      : loaded.batch.entity === "PRODUCTS"
        ? "import_apply_products"
        : "import_apply_expenses"

  const { data: summary, error: applyError } = await supabase.rpc(fn, {
    p_batch_id: batchId,
    p_rows: validation.rows,
  })

  if (applyError) {
    await supabase
      .from("import_batches")
      .update({ status: "FAILED", error: applyError.message })
      .eq("id", batchId)

    return {
      ok: false,
      error:
        `Nothing was imported. The whole import is applied in one step, so your ` +
        `existing data is untouched. Reason: ${applyError.message}`,
    }
  }

  // Auditable: who imported what, and when.
  await supabase.rpc("write_audit_log", {
    p_business_id: business.id,
    p_action: "import.completed",
    p_entity_type: `import:${loaded.batch.entity}`,
    p_entity_id: batchId,
    p_after: {
      file_name: loaded.batch.file_name,
      rows_valid: validation.validRowCount,
      rows_failed: validation.failedRowCount,
      summary,
    },
  })

  revalidatePath("/dashboard")
  revalidatePath("/imports")

  return { ok: true, summary: (summary ?? {}) as Record<string, number>, batchId }
}

export async function cancelImportAction(batchId: string) {
  const supabase = await createClient()
  await supabase
    .from("import_batches")
    .update({ status: "CANCELLED" })
    .eq("id", batchId)
    .neq("status", "COMPLETED")

  revalidatePath("/imports")
}

function channelLabel(source: string): string {
  const labels: Record<string, string> = {
    WEBSITE: "Website",
    SHOPIFY: "Shopify",
    WOOCOMMERCE: "WooCommerce",
    AMAZON: "Amazon",
    DARAZ: "Daraz",
    EBAY: "eBay",
    FACEBOOK: "Facebook",
    INSTAGRAM: "Instagram",
    POS: "POS",
    MANUAL: "Manual",
    OTHER: "Other",
  }
  return labels[source] ?? "Other"
}
