import { createHash } from "node:crypto"

import { revalidatePath } from "next/cache"
import { NextResponse } from "next/server"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { MAX_FILE_BYTES, MAX_ROWS, parseFile } from "@/services/ingestion/parse"
import { marketplaceAdapters } from "@/services/marketplaces/adapters"
import { matchIdenticalSkus } from "@/services/catalog/auto-match"
import { applyLedgerFile } from "@/services/marketplaces/apply"
import type { MappingRuleSummary, SourceRow } from "@/services/marketplaces/contract"
import { buildLedgerFilePayload } from "@/services/marketplaces/ledger-file"

/**
 * POST /api/v1/ledger-files — upload one marketplace settlement file.
 *
 * The whole path in one request, and nothing written until the very end:
 *
 *   read → recognise the format → the marketplace's adapter → customer-data
 *   filter and payload checks → ledger_apply_file() (one transaction)
 *
 * The business comes from the session, never from the request. The account
 * must belong to it, and the database checks membership and role again
 * (STAFF and above may import, decision B11). A known-bad report (Amazon's Date
 * Range report, the old flat file) is refused with what to download instead.
 */

const fieldsSchema = z.object({ marketplaceAccountId: z.string().uuid() })

const ACCEPTED = ["txt", "csv", "xlsx", "pdf"] as const
type Accepted = (typeof ACCEPTED)[number]

const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status })

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return refuse(401, "Not signed in.")

  const business = await getActiveBusiness()
  if (!business) return refuse(400, "No business selected.")
  if (business.role === "VIEWER") {
    return refuse(403, "Your role can view data but not import it. Ask an owner or admin.")
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return refuse(400, "The upload could not be read.")
  }

  const file = form.get("file")
  if (!(file instanceof File)) return refuse(400, "No file was attached.")

  const fields = fieldsSchema.safeParse({ marketplaceAccountId: form.get("marketplaceAccountId") })
  if (!fields.success) return refuse(400, "Choose the marketplace account this file belongs to.")

  const extension = (file.name.toLowerCase().split(".").pop() ?? "") as Accepted
  if (!ACCEPTED.includes(extension)) {
    return refuse(400, "Upload the file as the marketplace provides it (.txt, .csv, .xlsx or .pdf).")
  }
  if (file.size > MAX_FILE_BYTES) {
    return refuse(413, `That file is too large. The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
  }

  const supabase = await createClient()
  const { data: account } = await supabase
    .from("marketplace_accounts")
    .select("id, business_id, marketplace_code, label, currency, status")
    .eq("id", fields.data.marketplaceAccountId)
    .maybeSingle()

  if (!account || account.business_id !== business.id) {
    return refuse(404, "That marketplace account could not be found.")
  }
  if (account.status !== "ACTIVE") {
    return refuse(400, "That marketplace account is archived, so nothing more can be imported into it.")
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const sha256 = createHash("sha256").update(buffer).digest("hex")

  const parsed = await parseFile(buffer, file.name)
  if ("error" in parsed) return refuse(400, parsed.error)
  if (parsed.truncated) {
    return refuse(
      400,
      `This file has ${parsed.totalRowsInFile.toLocaleString("en-US")} rows; BizMind reads up to ` +
        `${MAX_ROWS.toLocaleString("en-US")} at once. Split it by settlement period and upload each part.`
    )
  }
  if (parsed.rows.length === 0) return refuse(400, "That file has column headings but no rows.")

  const detection = marketplaceAdapters.detect({
    fileName: file.name,
    headers: parsed.columns,
    rows: parsed.rows.slice(0, 5).map((row) => parsed.columns.map((column) => String(row[column] ?? ""))),
  })

  if (detection.kind === "reject") return refuse(422, detection.message)
  if (detection.kind === "ambiguous") {
    return refuse(422, "More than one marketplace format matches this file, so BizMind will not guess which it is.")
  }
  if (detection.kind === "unknown") {
    const help =
      account.marketplace_code === "NOON"
        ? "For noon, upload from Finance → Transaction View (item level) or Invoices and Credit Notes — both are needed for the same period."
        : "For Amazon, upload the settlement report downloaded as Flat File V2."
    return refuse(422, `BizMind does not recognise this file. ${help}`)
  }
  if (detection.adapter.marketplace !== account.marketplace_code) {
    return refuse(
      422,
      `This is a ${detection.format.label}, but "${account.label}" is not an account on that marketplace.`
    )
  }

  // Settlement reports are text. A spreadsheet that turned a cell into a number
  // has already changed it, so it is refused rather than converted back.
  const rows: SourceRow[] = []
  for (const [index, record] of parsed.rows.entries()) {
    const raw: Record<string, string | null> = {}
    for (const [column, value] of Object.entries(record)) {
      if (value === null || value === undefined) raw[column] = null
      else if (typeof value === "string") raw[column] = value
      else {
        return refuse(
          422,
          "This file was changed by a spreadsheet program (some cells are no longer text). " +
            "Upload the report exactly as the marketplace provides it."
        )
      }
    }
    rows.push({ rowNumber: index + 2, raw })
  }

  const { data: ruleRows, error: rulesError } = await supabase
    .from("ledger_mapping_rules")
    .select("id, match_key, side, category, subcategory, attribution, quantity_rule, sign_rule")
    .eq("marketplace_code", account.marketplace_code)
    .eq("format_id", detection.format.id)
    .eq("status", "ACTIVE")

  if (rulesError) return refuse(500, "BizMind could not load its classification rules. Try again shortly.")

  const rules: MappingRuleSummary[] = (ruleRows ?? []).map((rule) => ({
    id: rule.id,
    matchKey: rule.match_key,
    side: rule.side,
    category: rule.category as MappingRuleSummary["category"],
    subcategory: rule.subcategory,
    attribution: rule.attribution,
    quantityRule: rule.quantity_rule,
    signRule: rule.sign_rule,
  }))

  const result = detection.adapter.normalize({
    formatId: detection.format.id,
    rows,
    account: { id: account.id, marketplaceCode: account.marketplace_code, currency: account.currency },
    rules,
  })

  const built = buildLedgerFilePayload({
    accountId: account.id,
    accountCurrency: account.currency,
    format: detection.format,
    file: { name: file.name.slice(0, 255), type: extension, sizeBytes: file.size, sha256 },
    columns: parsed.columns,
    rows,
    result,
  })

  if (!built.ok) {
    return refuse(422, "This file could not be recorded. Nothing was saved.", { problems: built.problems })
  }

  const applied = await applyLedgerFile(built.payload)
  if (!applied.ok) return refuse(422, applied.error)

  // Known SKUs written differently (spaces, dashes, capitals) are matched to
  // their product at once. The file is recorded whether or not this succeeds.
  const matched = await matchIdenticalSkus(business.id)

  revalidatePath("/imports")
  revalidatePath("/catalog")

  return NextResponse.json({
    sourceFileId: applied.value.source_file_id,
    duplicate: applied.value.duplicate,
    format: detection.format.label,
    rows: applied.value.rows_written,
    transactions: applied.value.transactions_written,
    settlements: applied.value.settlements_written,
    payouts: applied.value.payouts_written,
    issues: applied.value.issues_written,
    unmapped: applied.value.unmapped_written,
    errors: result.issues.filter((issue) => issue.severity === "ERROR").length,
    warnings: result.issues.filter((issue) => issue.severity === "WARNING").length,
    skusMatchedAutomatically: matched,
  })
}
