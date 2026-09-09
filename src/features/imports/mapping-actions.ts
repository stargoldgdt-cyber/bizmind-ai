"use server"

import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient } from "@/lib/supabase/server"
import {
  canConfirmMappingTo,
  columnSignature,
  normaliseLabel,
  suggestMetricForColumn,
  type MappingConfidence,
} from "@/services/ingestion/canonical-mapping"
import type { MappingStatus } from "@/types/database"

/**
 * Server actions for the mapping layer.
 *
 * The business is always taken from the session. A client may say which column
 * it is talking about; it may never say which business it belongs to.
 *
 * NO ARITHMETIC HAPPENS HERE. These actions decide what a column MEANS. What
 * the numbers in it add up to is decided in SQL, as it is everywhere else.
 */

const CHANNELS = [
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
] as const

const ENTITIES = ["ORDERS", "PRODUCTS", "EXPENSES"] as const

const contextSchema = z.object({
  source: z.enum(CHANNELS),
  entity: z.enum(ENTITIES),
  columns: z.array(z.string()).min(1).max(500),
})

/** A stable key for a column, so "Amazon Fees" and "amazon fees" are one field. */
function keyFor(label: string): string {
  return normaliseLabel(label).replace(/ /g, "_")
}

/** One column, with everything known about what it means. */
export type ColumnMeaning = {
  sourceLabel: string
  fieldKey: string
  status: MappingStatus
  /** What BizMind suspects. A question, never an answer. */
  candidateMetric: string | null
  confidence: MappingConfidence | null
  reason: string | null
  ambiguityWarning: string | null
  /** What BizMind is permitted to use. Only ever set by a person. */
  mapsTo: string | null
  confirmedAt: string | null
}

export type ColumnMeaningsResult =
  | {
      ok: true
      /** A saved profile matched this exact file shape. */
      profileName: string | null
      signature: string
      meanings: ColumnMeaning[]
      /** Columns still needing a decision. Empty means nothing to ask. */
      needsDecision: ColumnMeaning[]
    }
  | { ok: false; error: string }

/**
 * Works out what each column in a file means, or admits that it does not know.
 *
 * Order of preference, and it matters:
 *   1. a decision already recorded for this business and source  -- reused
 *   2. a name-based suggestion                                   -- asked about
 *   3. nothing                                                   -- asked about
 *
 * A saved profile never means "import silently". A column that has appeared
 * since the profile was saved, or one whose meaning was never settled, comes
 * back in `needsDecision` so it gets asked about.
 */
export async function resolveColumnMeaningsAction(
  rawContext: unknown
): Promise<ColumnMeaningsResult> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  const parsed = contextSchema.safeParse(rawContext)
  if (!parsed.success) return { ok: false, error: "That file's columns could not be read." }

  const { source, entity, columns } = parsed.data
  const signature = columnSignature(columns)
  const supabase = await createClient()

  // Decisions already on record for this business and source. RLS scopes this
  // to the caller's own business; the business_id below is from the session.
  const { data: existing, error } = await supabase
    .from("source_field_semantics")
    .select(
      "field_key, source_label, status, candidate_metric, candidate_confidence, candidate_reason, ambiguity_warning, maps_to, confirmed_at"
    )
    .eq("business_id", business.id)
    .eq("source", source)

  if (error) return { ok: false, error: "Saved column meanings could not be read." }

  const known = new Map((existing ?? []).map((row) => [row.field_key, row]))

  const meanings: ColumnMeaning[] = columns.map((label) => {
    const fieldKey = keyFor(label)
    const row = known.get(fieldKey)

    if (row) {
      return {
        sourceLabel: row.source_label || label,
        fieldKey,
        status: row.status,
        candidateMetric: row.candidate_metric,
        confidence: row.candidate_confidence,
        reason: row.candidate_reason,
        ambiguityWarning: row.ambiguity_warning,
        mapsTo: row.maps_to,
        confirmedAt: row.confirmed_at,
      }
    }

    const suggestion = suggestMetricForColumn(label)
    return {
      sourceLabel: label,
      fieldKey,
      status: suggestion?.status ?? "PENDING_CONFIRMATION",
      candidateMetric: suggestion?.candidateMetric ?? null,
      confidence: suggestion?.confidence ?? null,
      reason: suggestion?.reason ?? null,
      ambiguityWarning: suggestion?.ambiguityWarning ?? null,
      mapsTo: null,
      confirmedAt: null,
    }
  })

  // Record the suggestions so the questions survive a page reload. The RPC
  // cannot write `maps_to` and cannot write CONFIRMED, so this stores what
  // BizMind suspects and nothing more.
  for (const meaning of meanings) {
    if (meaning.confirmedAt !== null || known.has(meaning.fieldKey)) continue
    await supabase.rpc("suggest_source_field_semantics", {
      p_business_id: business.id,
      p_source: source,
      p_entity: entity,
      p_field_key: meaning.fieldKey,
      p_source_label: meaning.sourceLabel,
      p_candidate_metric: meaning.candidateMetric,
      p_confidence: meaning.confidence,
      p_reason: meaning.reason,
      p_ambiguity: meaning.ambiguityWarning,
    })
  }

  const { data: profile } = await supabase
    .from("source_mapping_profiles")
    .select("name")
    .eq("business_id", business.id)
    .eq("source", source)
    .eq("entity", entity)
    .eq("signature", signature)
    .maybeSingle()

  return {
    ok: true,
    profileName: profile?.name ?? null,
    signature,
    meanings,
    // A column whose meaning nobody has settled. "I don't know" counts as
    // settled: it was asked and answered, and asking again helps nobody.
    needsDecision: meanings.filter(
      (m) => m.status === "SUGGESTED" || m.status === "PENDING_CONFIRMATION"
    ),
  }
}

const decisionSchema = z.object({
  source: z.enum(CHANNELS),
  entity: z.enum(ENTITIES),
  fieldKey: z.string().min(1).max(200),
  sourceLabel: z.string().min(1).max(300),
  decision: z.enum(["CONFIRMED", "REJECTED", "UNKNOWN"]),
  /** Required when confirming, refused otherwise. */
  metric: z.string().min(1).max(100).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
})

export type DecisionResult =
  | { ok: true; status: MappingStatus; mapsTo: string | null }
  | { ok: false; error: string }

/**
 * Records what a person says a column means.
 *
 * This is the only way a source figure can ever become a BizMind figure. The
 * database checks the caller's role, refuses a mapping that is not confirmed,
 * refuses a confirmation with no name attached, refuses a metric that is not
 * in the vocabulary, and writes an audit entry. The checks here are the early,
 * friendlier version of the same refusals -- not a substitute for them.
 */
export async function decideColumnMeaningAction(
  rawInput: unknown
): Promise<DecisionResult> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  const parsed = decisionSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That decision could not be read." }

  const { source, entity, fieldKey, sourceLabel, decision, metric, note } = parsed.data

  if (decision === "CONFIRMED") {
    if (!metric) {
      return { ok: false, error: "Choose which BizMind figure this column is." }
    }
    if (!canConfirmMappingTo(metric)) {
      return {
        ok: false,
        error:
          "BizMind works that figure out for itself from numbers it has checked, " +
          "so a column cannot be mapped to it. Map the figures it is built from instead.",
      }
    }
  } else if (metric) {
    return { ok: false, error: "A column can only be mapped to a figure when it is confirmed." }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("confirm_source_field_semantics", {
    p_business_id: business.id,
    p_source: source,
    p_field_key: fieldKey,
    p_status: decision,
    p_maps_to: decision === "CONFIRMED" ? (metric ?? null) : null,
    p_note: note ?? null,
    p_source_label: sourceLabel,
    p_entity: entity,
  })

  if (error) {
    // Role failures are the common case and worth saying plainly. Anything
    // else is reported without the database's own wording, which would leak
    // constraint and column names to the browser.
    const permission = error.message.includes("owner or admin")
    return {
      ok: false,
      error: permission
        ? "Only an owner or admin can confirm what a column means."
        : "That meaning could not be saved.",
    }
  }

  return { ok: true, status: data.status, mapsTo: data.maps_to }
}

const profileSchema = z.object({
  source: z.enum(CHANNELS),
  entity: z.enum(ENTITIES),
  name: z.string().min(1).max(200),
  columns: z.array(z.string()).min(1).max(500),
})

export type SaveProfileResult = { ok: true; profileId: string } | { ok: false; error: string }

/**
 * Saves this file shape so the same questions are not asked next month.
 *
 * The profile stores which columns it covers, never what they mean. Meaning is
 * reached through the semantics rows, behind the constraints, so a saved
 * profile cannot carry a mapping the gate would have refused.
 */
export async function saveMappingProfileAction(
  rawInput: unknown
): Promise<SaveProfileResult> {
  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  const parsed = profileSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: "That mapping could not be saved." }

  const { source, entity, name, columns } = parsed.data

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("save_mapping_profile", {
    p_business_id: business.id,
    p_source: source,
    p_entity: entity,
    p_name: name,
    p_signature: columnSignature(columns),
    p_columns: columns,
    p_field_keys: columns.map(keyFor),
  })

  if (error) return { ok: false, error: "That mapping could not be saved." }
  return { ok: true, profileId: data.id }
}
