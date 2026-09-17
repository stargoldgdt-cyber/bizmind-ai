import { NextResponse } from "next/server"
import { z } from "zod"

import { getActiveBusiness } from "@/features/businesses/queries"
import { getLedgerMonth, listLedgerAccounts } from "@/features/ledger/queries"
import { getCurrentUser } from "@/lib/supabase/server"
import { buildCsv, ledgerExportRows } from "@/services/ledger/export"
import { parseLedgerMonth } from "@/services/ledger/period"

/**
 * GET /api/v1/ledger/export?account=<id>&month=YYYY-MM
 *
 * The validation export: one account's month as CSV, to compare with the
 * marketplace's own reports. The business comes from the session; the account
 * must belong to it; every figure is read through the user's session (RLS) and
 * written exactly as the database produced it.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })

  const business = await getActiveBusiness()
  if (!business) return NextResponse.json({ error: "No business selected." }, { status: 400 })

  const url = new URL(request.url)
  const accountId = z.string().uuid().safeParse(url.searchParams.get("account"))
  const month = parseLedgerMonth(url.searchParams.get("month"))
  if (!accountId.success || !month) {
    return NextResponse.json({ error: "Choose an account and a month." }, { status: 400 })
  }

  const accounts = await listLedgerAccounts(business.id)
  const account = accounts.find((a) => a.id === accountId.data)
  if (!account) return NextResponse.json({ error: "That marketplace account could not be found." }, { status: 404 })

  const data = await getLedgerMonth(business.id, account.id, month)
  const csv = buildCsv(
    ledgerExportRows({
      businessName: business.name,
      accountLabel: account.label,
      marketplaceCode: account.marketplace_code,
      currency: account.currency,
      month,
      ...data,
    })
  )

  const slug = account.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "account"

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bizmind-${slug}-${month.key}.csv"`,
      "Cache-Control": "no-store",
    },
  })
}
