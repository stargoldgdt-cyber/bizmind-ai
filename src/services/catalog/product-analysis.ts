import { z } from "zod"

/**
 * The shape of what product_analysis() (migration 0070) returns.
 *
 * It is one jsonb document, so it is parsed at the boundary rather than
 * trusted: a column the page relies on going missing fails here, loudly,
 * instead of rendering a blank figure. Money is exact decimal text and stays
 * text; percentages are numbers the database already rounded. Nothing in this
 * file calculates anything.
 */

const money = z.string()
const moneyOrNull = z.string().nullable()
const percent = z.number().nullable()

const COGS_STATUS = z.enum(["COSTED", "NOT_APPLICABLE", "NO_COST", "PARTLY_COSTED"])

const period = z.object({
  units: money,
  net_sales: money,
  costs: money,
  cogs: moneyOrNull,
  gross_profit: moneyOrNull,
  margin: moneyOrNull,
  /** Marketplace costs as a share of net sales. */
  costs_pct: percent,
  /** Product cost as a share of net sales. */
  cogs_pct: percent,
  cogs_status: COGS_STATUS,
  lines: z.number(),
})

const month = z.object({
  month: z.string(),
  has_lines: z.boolean(),
  units: money,
  net_sales: money,
  costs: money,
  gross_profit: moneyOrNull,
  margin: moneyOrNull,
  /** 0-1000 positions on one shared scale, worked out in SQL. */
  net_sales_y: z.number(),
  gross_profit_y: z.number().nullable(),
  zero_y: z.number(),
})

const marketplace = z.object({
  account_id: z.string(),
  account_label: z.string(),
  marketplace_code: z.string(),
  units: money,
  net_sales: money,
  costs: money,
  cogs: moneyOrNull,
  gross_profit: moneyOrNull,
  margin: moneyOrNull,
})

/** Same shape as dashboard_cost_breakdown, so the overview's donut draws it. */
const cost = z.object({
  category: z.string(),
  label: z.string(),
  lines: z.number(),
  total: money,
  pct_of_net_sales: percent,
  pct_of_costs: percent,
  bar: z.number(),
})

const price = z.object({
  target_margin: z.number(),
  average_price: money,
  unit_cogs: money,
  unit_costs: money,
  break_even_price: money,
  required_price: moneyOrNull,
  increase_amount: moneyOrNull,
  increase_pct: percent,
})

const order = z.object({
  order_ref: z.string(),
  marketplace_code: z.string(),
  posted_at: z.string(),
  units: money,
  net_sales: money,
  profit: moneyOrNull,
})

const analysisSchema = z.object({
  currency: z.string(),
  current: period.nullable(),
  previous: period.nullable(),
  changes: z
    .object({
      net_sales_pct: percent,
      units_pct: percent,
      gross_profit_pct: percent,
      /** Margin change in percentage points. */
      margin_points: percent,
    })
    .nullable(),
  months: z.array(month),
  marketplaces: z.array(marketplace),
  costs: z.array(cost),
  costs_total: money,
  price: price.nullable(),
  orders: z.array(order),
})

export type ProductAnalysis = z.infer<typeof analysisSchema>
export type AnalysisPeriod = z.infer<typeof period>
export type AnalysisMonth = z.infer<typeof month>
export type AnalysisMarketplace = z.infer<typeof marketplace>
export type AnalysisCost = z.infer<typeof cost>
export type AnalysisPrice = z.infer<typeof price>
export type AnalysisOrder = z.infer<typeof order>

export function parseProductAnalysis(value: unknown): ProductAnalysis {
  const parsed = analysisSchema.safeParse(value)
  if (!parsed.success) throw new Error("The product analysis came back in an unexpected shape.")
  return parsed.data
}

/** The target margins the price check can be set to. A fixed list: the URL carries one of these. */
export const TARGET_MARGINS = [5, 10, 15, 20, 25] as const
export const DEFAULT_TARGET_MARGIN = 15

export function parseTargetMargin(value: string | undefined): number {
  return TARGET_MARGINS.find((margin) => String(margin) === value) ?? DEFAULT_TARGET_MARGIN
}
