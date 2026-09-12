import "server-only"

/**
 * The AI service layer.
 *
 * Everything the rest of BizMind is allowed to know about language models.
 * Nothing outside `src/services/ai/` calls one, and nothing outside this file
 * needs to know that one exists: the return types make an unavailable model
 * an ordinary outcome rather than an error to handle.
 *
 * See AI.md for the rules this layer exists to enforce.
 */

export { briefForPeriod, explainMetric, explainPeriod, parseBrief } from "./analyst"
export type { BriefResult, BusinessBrief, Narration, SuppressionReason } from "./analyst"
export { aiModel, isAiConfigured } from "./client"
export { buildFactSheet, renderFactSheet } from "./facts"
export type { Fact, FactSheet, FactSheetInput } from "./facts"
