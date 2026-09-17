import { NextResponse } from "next/server"

import { getActiveBusiness } from "@/features/businesses/queries"
import { loadReport } from "@/features/reports/queries"
import { getCurrentUser } from "@/lib/supabase/server"
import { parseLedgerMonth } from "@/services/ledger/period"
import { isReportKey, REPORT_CATALOG } from "@/services/reports/catalog"
import { reportWorkbook } from "@/services/reports/xlsx"

/**
 * GET /api/v1/reports/<report>?month=YYYY-MM
 *
 * One catalogue report as an Excel workbook. The business comes from the
 * session and every figure is read through the user's session (RLS); nothing
 * is calculated here.
 */
export async function GET(request: Request, context: RouteContext<"/api/v1/reports/[report]">) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })

  const business = await getActiveBusiness()
  if (!business) return NextResponse.json({ error: "No business selected." }, { status: 400 })

  const { report } = await context.params
  if (!isReportKey(report)) return NextResponse.json({ error: "That report does not exist." }, { status: 404 })

  const month = parseLedgerMonth(new URL(request.url).searchParams.get("month"))
  if (REPORT_CATALOG[report].monthly && !month && report !== "payouts") {
    return NextResponse.json({ error: "Choose a month." }, { status: 400 })
  }

  try {
    const workbook = await reportWorkbook(await loadReport(business, report, month))
    return new Response(new Uint8Array(workbook), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="bizmind-${report}${month ? `-${month.key}` : ""}.xlsx"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    console.error("[reports] export failed", error instanceof Error ? error.message : error)
    return NextResponse.json({ error: "The report could not be prepared. Try again." }, { status: 500 })
  }
}
