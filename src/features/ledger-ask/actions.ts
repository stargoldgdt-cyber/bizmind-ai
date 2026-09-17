"use server"

import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient } from "@/lib/supabase/server"
import {
  answerLedgerQuestion,
  isLedgerQuestion,
  QUESTION_NEEDS,
  type LedgerAnswer,
  type LedgerFactInput,
} from "@/services/ai"
import { parseLedgerMonth } from "@/services/ledger/period"

/**
 * Ask BizMind about the marketplace ledger (GCC Phase 9).
 *
 * THE FIGURES ARE NEVER ACCEPTED FROM THE CLIENT. The browser sends a question
 * key and a month; the business comes from the session, and every figure is
 * read here, through the person's session (RLS), from the same SQL readers as
 * the screens -- only the ones the question needs.
 */

const requestSchema = z.object({
  question: z.string().refine(isLedgerQuestion),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
})

export async function askLedgerQuestionAction(
  input: unknown
): Promise<{ ok: true; answer: LedgerAnswer } | { ok: false; error: string }> {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success || !isLedgerQuestion(parsed.data.question)) return { ok: false, error: "Choose a question and a month." }
  const month = parseLedgerMonth(parsed.data.month)
  if (!month) return { ok: false, error: "Choose a month." }

  const business = await getActiveBusiness()
  if (!business) return { ok: false, error: "No business selected." }

  const question = parsed.data.question
  const needs = new Set(QUESTION_NEEDS[question])
  const supabase = await createClient()
  const range = { p_from: month.from, p_to: month.to }
  const input_: LedgerFactInput = { businessName: business.name, monthLabel: month.label }

  try {
    const load = async <T,>(wanted: boolean, run: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) => {
      if (!wanted) return undefined
      const { data, error } = await run()
      if (error) throw new Error(error.message)
      return data ?? []
    }
    const [perAccount, perCurrency, net, products, quality, payouts, expenses] = await Promise.all([
      load(needs.has("perAccount"), () => supabase.rpc("pnl_summary", { ...range, p_business_id: business.id })),
      load(needs.has("perCurrency"), () =>
        supabase.rpc("pnl_summary", { ...range, p_business_id: business.id, p_combine_by_currency: true })),
      load(needs.has("net"), () => supabase.rpc("pnl_net_profit", { ...range, p_business_id: business.id })),
      load(needs.has("products"), () => supabase.rpc("pnl_by_product", { ...range, p_business_id: business.id })),
      load(needs.has("quality"), () => supabase.rpc("ledger_data_quality", { ...range, p_business_id: business.id })),
      load(needs.has("payouts"), () =>
        supabase.rpc("expected_payouts", { p_business_id: business.id, ...range })),
      load(needs.has("expenses"), () => supabase.rpc("expense_breakdown", { ...range, p_business_id: business.id })),
    ])
    Object.assign(input_, { perAccount, perCurrency, net, products, quality, payouts, expenses })
  } catch (error) {
    console.error("[ask-ledger] figures could not be loaded", error instanceof Error ? error.message : "unknown")
    return { ok: false, error: "The figures could not be loaded. Try again." }
  }

  return { ok: true, answer: await answerLedgerQuestion(question, input_) }
}
