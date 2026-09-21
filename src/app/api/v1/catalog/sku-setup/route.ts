import { NextResponse } from "next/server"

import { getActiveBusiness } from "@/features/businesses/queries"
import { getSkuSetupRows } from "@/features/catalog/queries"
import { getCurrentUser } from "@/lib/supabase/server"
import { skuSetupWorkbook } from "@/services/catalog/sku-setup-workbook"

/**
 * GET /api/v1/catalog/sku-setup            the SKUs that need a product
 * GET /api/v1/catalog/sku-setup?scope=all  every SKU, for bulk corrections
 *
 * The one-sheet SKU setup workbook (migration 0045). The business comes from
 * the session and every row is read through the user's session (RLS).
 */
export async function GET(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })

  const business = await getActiveBusiness()
  if (!business) return NextResponse.json({ error: "No business selected." }, { status: 400 })

  const all = new URL(request.url).searchParams.get("scope") === "all"
  try {
    const rows = await getSkuSetupRows(business.id, all)
    const workbook = await skuSetupWorkbook(rows)
    return new Response(new Uint8Array(workbook), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="bizmind-sku-setup${all ? "-all" : ""}.xlsx"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    console.error("[catalog] SKU setup export failed", error instanceof Error ? error.message : error)
    return NextResponse.json({ error: "The sheet could not be prepared. Try again." }, { status: 500 })
  }
}
