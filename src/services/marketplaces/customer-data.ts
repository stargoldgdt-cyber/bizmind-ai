/**
 * The customer-data filter (decision A14).
 *
 * Buyer names, emails, phone numbers and addresses never enter `source_rows`
 * or the ledger. This is the first of two barriers:
 *
 *   1. HERE, at the adaptation boundary: a row keeps only its format's allowed
 *      columns, and a column that looks like customer data is dropped even if a
 *      format mistakenly allows it. What was dropped is recorded by NAME in
 *      `stripped_columns` -- the name, never the value.
 *   2. IN THE DATABASE: `ledger_raw_is_clean()` and the email checks in
 *      migration 0030 refuse the same things again, so a bug here cannot leak.
 *
 * The two patterns are copied verbatim into the migration. A test fails if they
 * differ.
 *
 * WHAT A PATTERN CANNOT DO
 * ------------------------
 * It can recognise a customer COLUMN and an email ADDRESS. It cannot recognise a
 * person's name typed into a free-text description. That is why the real
 * protection is structural: formats allow-list their columns, and no ledger
 * table has a column for a customer at all.
 */

export const CUSTOMER_COLUMN_PATTERN =
  "(buyer|customer|recipient|ship[-_ ]?to|bill[-_ ]?to|e-?mail|phone|mobile|telephone|whatsapp|address|street|post[-_ ]?code|postal|zip[-_ ]?code|first[-_ ]?name|last[-_ ]?name|full[-_ ]?name|contact)"

export const EMAIL_PATTERN = "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}"

const customerColumn = new RegExp(CUSTOMER_COLUMN_PATTERN, "i")
const emailAddress = new RegExp(EMAIL_PATTERN, "i")

export function isCustomerDataColumn(name: string): boolean {
  return customerColumn.test(name)
}

export function containsEmailAddress(value: string): boolean {
  return emailAddress.test(value)
}

export type FilteredRow = {
  /** Only allowed, non-customer columns. Blank cells are `null`. */
  kept: Record<string, string | null>
  /** Column names removed, in the order met. */
  stripped: string[]
}

/**
 * Keeps a row's allowed columns and nothing else.
 *
 * A blank or whitespace-only cell becomes `null` -- unknown, not zero, not "".
 * Any other text is kept exactly as read. A value that is not text is refused
 * rather than converted: converting a number is exactly how a decimal loses
 * digits.
 */
export function filterSourceRow(
  raw: Readonly<Record<string, string | null | undefined>>,
  allowedColumns: readonly string[]
): FilteredRow {
  const allowed = new Set(allowedColumns)
  const kept: Record<string, string | null> = {}
  const stripped: string[] = []

  for (const [column, value] of Object.entries(raw)) {
    if (!allowed.has(column) || isCustomerDataColumn(column)) {
      stripped.push(column)
      continue
    }

    if (value === null || value === undefined) {
      kept[column] = null
    } else if (typeof value === "string") {
      kept[column] = value.trim() === "" ? null : value
    } else {
      throw new TypeError(`Column "${column}" is not text. Source values must be read as text.`)
    }
  }

  return { kept, stripped }
}
