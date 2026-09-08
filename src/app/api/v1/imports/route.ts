import { NextResponse } from "next/server"

import { getActiveBusiness } from "@/features/businesses/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import type { EntityKey } from "@/services/ingestion/contracts"
import { ENTITIES } from "@/services/ingestion/entities"
import { suggestMapping } from "@/services/ingestion/mapping"
import { MAX_FILE_BYTES, MAX_ROWS, parseFile } from "@/services/ingestion/parse"
import type { Json } from "@/types/database"

/**
 * POST /api/v1/imports — upload and parse a file.
 *
 * Creates a DRAFT batch holding the parsed rows, and returns the detected
 * columns plus a SUGGESTED mapping. Nothing is written to the business data
 * model here; the suggestion is a starting point the user must confirm.
 *
 * The business is taken from the session, never from the request body. A
 * caller cannot upload into a business they do not belong to.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  }

  const business = await getActiveBusiness()
  if (!business) {
    return NextResponse.json({ error: "No business selected." }, { status: 400 })
  }

  // Importing writes business data, so a VIEWER may not do it. RLS would
  // refuse anyway; failing here gives a readable message instead of a
  // database error at the end of a long upload.
  if (business.role === "VIEWER") {
    return NextResponse.json(
      { error: "Your role can view data but not import it. Ask an owner or admin." },
      { status: 403 }
    )
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: "The upload could not be read." }, { status: 400 })
  }

  const file = form.get("file")
  const entityKey = String(form.get("entity") ?? "") as EntityKey

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was attached." }, { status: 400 })
  }

  if (!(entityKey in ENTITIES)) {
    return NextResponse.json({ error: "Unknown import type." }, { status: 400 })
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `That file is too large. The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.` },
      { status: 413 }
    )
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const parsed = await parseFile(buffer, file.name)

  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  if (parsed.rows.length === 0) {
    return NextResponse.json(
      { error: "That file has column headings but no data rows." },
      { status: 400 }
    )
  }

  const entity = ENTITIES[entityKey]
  const fileType = file.name.toLowerCase().endsWith(".csv") ? "csv" : "xlsx"

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("import_batches")
    .insert({
      business_id: business.id,
      created_by: user.id,
      entity: entityKey,
      status: "DRAFT",
      file_name: file.name.slice(0, 255),
      file_type: fileType,
      file_size_bytes: file.size,
      columns: parsed.columns,
      // The parsed file goes into a jsonb column. RawRecord holds `unknown`
      // values by design (a cell can be a string, number or date), which is
      // wider than the Json type; the cast is at the storage boundary only.
      raw_rows: parsed.rows as unknown as Json,
      row_count: parsed.rows.length,
    })
    .select("id")
    .single()

  if (error) {
    return NextResponse.json(
      { error: `The file could not be saved: ${error.message}` },
      { status: 500 }
    )
  }

  return NextResponse.json({
    batchId: data.id,
    entity: entityKey,
    columns: parsed.columns,
    rowCount: parsed.rows.length,
    truncated: parsed.truncated,
    totalRowsInFile: parsed.totalRowsInFile,
    maxRows: MAX_ROWS,
    suggestedMapping: suggestMapping(entity, parsed.columns),
    sampleRows: parsed.rows.slice(0, 5),
  })
}
