import "server-only"

import ExcelJS from "exceljs"
import Papa from "papaparse"
import PdfParse from "pdf-parse"

import type { RawRecord } from "./contracts"

/**
 * Turns an uploaded file into raw records.
 *
 * Parsing happens on the SERVER. Doing it in the browser would be faster to
 * build, but then the shape of the data would be decided by client code, and
 * everything after this point is a trust boundary.
 */

/** Big enough for real exports, small enough to stay well inside memory. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const MAX_ROWS = 20_000

export type ParsedFile = {
  columns: string[]
  rows: RawRecord[]
  /** Rows found before the cap was applied, so truncation can be reported. */
  totalRowsInFile: number
  truncated: boolean
}

export type ParseFailure = { error: string }

export async function parseFile(
  buffer: Buffer,
  fileName: string
): Promise<ParsedFile | ParseFailure> {
  const extension = fileName.toLowerCase().split(".").pop() ?? ""

  if (buffer.byteLength === 0) return { error: "That file is empty." }
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return {
      error: `That file is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is ${
        MAX_FILE_BYTES / 1024 / 1024
      } MB — split it into smaller files, or export a narrower date range.`,
    }
  }

  if (extension === "csv" || extension === "txt") return parseCsv(buffer)
  if (extension === "xlsx" || extension === "xlsm") return parseXlsx(buffer)
  if (extension === "pdf") return parsePdf(buffer)

  return {
    error: `BizMind cannot read ".${extension}" files. Upload a CSV, an Excel (.xlsx) or a PDF file.`,
  }
}

/**
 * A PDF has no rows or columns, only text — and unlike a settlement file, one
 * PDF is one document (a tax invoice, a credit note), not a table. This hands
 * the whole extracted text over as a single row, in a single "text" column, so
 * the row-accounting the database requires ("every row is used by something")
 * stays meaningful instead of forcing every page header and column label into
 * its own row issue. Recognising the table inside that text is the adapter's
 * job (contract.ts: "transport and meaning are separate"), not this file's.
 */
async function parsePdf(buffer: Buffer): Promise<ParsedFile | ParseFailure> {
  let text: string
  try {
    text = await extractPdfText(buffer)
  } catch {
    return {
      error: "That PDF could not be read. If it is password protected, remove the password and try again.",
    }
  }

  if (text.trim() === "") {
    return { error: "That PDF has no readable text. A scanned image cannot be read; upload the original PDF." }
  }

  return {
    columns: ["text"],
    rows: [{ text }],
    totalRowsInFile: 1,
    truncated: false,
  }
}

/**
 * pdf-parse's very first call in a process can throw on a PDF it reads fine
 * on a later call (observed on a real, slightly malformed Amazon tax
 * document: the first parse threw a stream/xref error with a different
 * message each time, while every retry read it correctly, byte for byte).
 * Three attempts, immediately, no delay: this is a one-time warm-up quirk in
 * the underlying library on a genuinely borderline file, not a signal to
 * keep trying indefinitely.
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await PdfParse(buffer)).text
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function parseCsv(buffer: Buffer): ParsedFile | ParseFailure {
  // Strip a UTF-8 byte order mark, which Excel adds and which would otherwise
  // become part of the first column's name.
  let text = buffer.toString("utf8")
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    // Values stay as strings on purpose. Papa's dynamic typing would turn
    // "0012" into 12 and money into floating point before we ever see it.
    dynamicTyping: false,
    transformHeader: (header) => header.trim(),
  })

  const fatal = parsed.errors.find((e) => e.type === "Delimiter" || e.type === "Quotes")
  if (fatal) {
    return {
      error: `That CSV could not be read (${fatal.message}). Check it opens correctly in a spreadsheet first.`,
    }
  }

  const columns = (parsed.meta.fields ?? []).filter((c) => c && c.trim() !== "")
  if (columns.length === 0) {
    return { error: "No column headings were found. The first row must contain column names." }
  }

  const all = parsed.data.filter((row) =>
    Object.values(row).some((v) => v !== null && v !== undefined && String(v).trim() !== "")
  )

  return {
    columns,
    rows: all.slice(0, MAX_ROWS),
    totalRowsInFile: all.length,
    truncated: all.length > MAX_ROWS,
  }
}

async function parseXlsx(buffer: Buffer): Promise<ParsedFile | ParseFailure> {
  const workbook = new ExcelJS.Workbook()

  try {
    // ExcelJS types the loader against its own ArrayBuffer-ish shape; a Node
    // Buffer is accepted at runtime and is what the upload hands us.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch {
    return {
      error: "That Excel file could not be opened. If it is password protected, remove the password and try again.",
    }
  }

  const sheet = workbook.worksheets[0]
  if (!sheet) return { error: "That workbook has no sheets." }

  const headerRow = sheet.getRow(1)
  const columns: string[] = []
  headerRow.eachCell({ includeEmpty: false }, (cellValue, colNumber) => {
    const name = flatten(cellValue.value)
    columns[colNumber - 1] = name === null ? "" : String(name).trim()
  })

  const named = columns.filter((c) => c && c.trim() !== "")
  if (named.length === 0) {
    return { error: "No column headings were found in the first row of the sheet." }
  }

  const rows: RawRecord[] = []
  let total = 0

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return

    const record: RawRecord = {}
    let hasValue = false

    row.eachCell({ includeEmpty: false }, (cellValue, colNumber) => {
      const key = columns[colNumber - 1]
      if (!key) return
      const value = flatten(cellValue.value)
      if (value !== null && String(value).trim() !== "") hasValue = true
      record[key] = value
    })

    if (!hasValue) return
    total += 1
    if (rows.length < MAX_ROWS) rows.push(record)
  })

  return {
    columns: named,
    rows,
    totalRowsInFile: total,
    truncated: total > MAX_ROWS,
  }
}

/**
 * ExcelJS returns rich objects for formulas, hyperlinks and styled text.
 * Reduce each to the value a person would see in the cell.
 */
function flatten(value: unknown): string | number | Date | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value
  if (typeof value === "number" || typeof value === "string") return value
  if (typeof value === "boolean") return String(value)

  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    // Formula cell: use the computed result, not the formula text.
    if ("result" in v) return flatten(v.result)
    if ("text" in v && typeof v.text === "string") return v.text
    if ("richText" in v && Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((p) => p.text ?? "").join("")
    }
    if ("hyperlink" in v && typeof v.hyperlink === "string") return v.hyperlink
    if ("error" in v) return null
  }

  return String(value)
}
