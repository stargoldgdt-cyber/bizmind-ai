import type {
  FormatDescriptor,
  NormalizeResult,
  PayoutDraft,
  SettlementDraft,
  TransactionDraft,
} from "./contract"
import { UNMAPPED } from "./contract"
import { containsEmailAddress, filterSourceRow } from "./customer-data"

/**
 * Builds the payload for `ledger_apply_file()`.
 *
 * Pure. It applies the customer-data filter to every row, then checks the same
 * rules the database will check, so a problem is reported in words before any
 * request is made. The database checks all of it again and trusts none of this.
 *
 * The two patterns below are copied verbatim into migration 0030. A test fails
 * if they differ.
 */

export const EXACT_DECIMAL_PATTERN = "^-?[0-9]{1,16}(\\.[0-9]{1,4})?$"
export const INSTANT_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$"

/** The database refuses larger files; split them. */
export const MAX_LEDGER_ROWS = 50_000

const exactDecimal = new RegExp(EXACT_DECIMAL_PATTERN)
const instant = new RegExp(INSTANT_PATTERN)
const SHA256 = /^[0-9a-f]{64}$/

export type LedgerFileInput = {
  accountId: string
  accountCurrency: string
  format: FormatDescriptor
  file: { name: string; type: "csv" | "xlsx"; sizeBytes: number; sha256: string }
  sourceKind?: "UPLOAD" | "API"
  /** Every header the file had, before filtering. Names only. */
  columns: readonly string[]
  rows: readonly { rowNumber: number; raw: Readonly<Record<string, string | null | undefined>> }[]
  result: NormalizeResult
}

export type LedgerFilePayload = {
  marketplace_account_id: string
  format_id: string
  adapter_version: string
  source_kind: "UPLOAD" | "API"
  file_name: string
  file_type: "csv" | "xlsx"
  file_size_bytes: number
  file_sha256: string
  columns: string[]
  stripped_columns: string[]
  rows: { row_number: number; raw: Record<string, string | null> }[]
  settlements: {
    external_settlement_id: string
    source_row_number: number
    period_start: string | null
    period_end: string | null
    reported_total: string | null
    reported_deposit_date: string | null
    currency: string
  }[]
  payouts: {
    key: string
    source_row_number: number
    external_ref: string | null
    amount: string
    currency: string
    paid_at: string | null
    settlement_ref: string | null
  }[]
  transactions: {
    source_row_number: number
    line_index: number
    mapping_rule_id: string | null
    side: string | null
    category: string
    subcategory: string | null
    source_type: string | null
    source_subtype: string | null
    source_description: string | null
    amount: string
    currency: string
    posted_at: string
    order_ref: string | null
    order_line_ref: string | null
    raw_sku: string | null
    quantity: string | null
    quantity_basis: string | null
    attribution: string
    settlement_ref: string | null
    payout_ref: string | null
  }[]
  issues: {
    row_number: number
    severity: "ERROR" | "WARNING"
    field: string | null
    message: string
    raw_value: string | null
  }[]
}

export type BuildResult = { ok: true; payload: LedgerFilePayload } | { ok: false; problems: string[] }

const MAX_PROBLEMS = 20

export function buildLedgerFilePayload(input: LedgerFileInput): BuildResult {
  const problems: string[] = []
  const report = (message: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(message)
  }

  const { result } = input

  if (!SHA256.test(input.file.sha256)) report("The file fingerprint must be a lowercase SHA-256 digest.")
  if (containsEmailAddress(input.file.name)) report("The file name contains an email address.")
  if (input.rows.length === 0) report("A ledger file needs at least one source row.")
  if (input.rows.length > MAX_LEDGER_ROWS) {
    report(`A ledger file may hold at most ${MAX_LEDGER_ROWS.toLocaleString("en-US")} rows. Split it.`)
  }

  // ---- rows, through the customer-data filter --------------------------------
  const stripped = new Set<string>()
  const rows: LedgerFilePayload["rows"] = []
  const rowNumbers = new Set<number>()

  for (const row of input.rows) {
    if (!Number.isInteger(row.rowNumber) || row.rowNumber < 1) {
      report(`Row ${row.rowNumber} does not have a valid row number.`)
      continue
    }
    if (rowNumbers.has(row.rowNumber)) {
      report(`Row number ${row.rowNumber} appears more than once.`)
      continue
    }
    rowNumbers.add(row.rowNumber)

    let filtered
    try {
      filtered = filterSourceRow(row.raw, input.format.allowedColumns)
    } catch (error) {
      report(`Row ${row.rowNumber}: ${(error as Error).message}`)
      continue
    }

    for (const column of filtered.stripped) stripped.add(column)

    for (const [column, value] of Object.entries(filtered.kept)) {
      if (value !== null && containsEmailAddress(value)) {
        report(`Row ${row.rowNumber}, column "${column}", contains an email address.`)
      }
    }

    rows.push({ row_number: row.rowNumber, raw: filtered.kept })
  }

  const hasRow = (rowNumber: number) => rowNumbers.has(rowNumber)
  const accounted = new Set<number>()

  // ---- settlements ------------------------------------------------------------
  const settlementIds = new Set<string>()
  const settlements = result.settlements.map((draft: SettlementDraft, index) => {
    const label = `Settlement ${index + 1}`
    if (!draft.externalSettlementId) report(`${label}: external settlement id is required.`)
    if (settlementIds.has(draft.externalSettlementId)) {
      report(`${label}: ${draft.externalSettlementId} appears more than once.`)
    }
    settlementIds.add(draft.externalSettlementId)
    if (!hasRow(draft.sourceRowNumber)) report(`${label}: it points at no source row.`)
    if (draft.currency !== input.accountCurrency) {
      report(`${label}: currency ${draft.currency} does not match the account currency ${input.accountCurrency}.`)
    }
    if (draft.reportedTotal !== null && !exactDecimal.test(draft.reportedTotal)) {
      report(`${label}: reported total must be exact decimal text or blank.`)
    }
    for (const value of [draft.periodStart, draft.periodEnd, draft.reportedDepositDate]) {
      if (value !== null && !instant.test(value)) report(`${label}: dates must carry a time zone.`)
    }
    accounted.add(draft.sourceRowNumber)

    return {
      external_settlement_id: draft.externalSettlementId,
      source_row_number: draft.sourceRowNumber,
      period_start: draft.periodStart,
      period_end: draft.periodEnd,
      reported_total: draft.reportedTotal,
      reported_deposit_date: draft.reportedDepositDate,
      currency: draft.currency,
    }
  })

  // ---- payouts ----------------------------------------------------------------
  const payoutKeys = new Set<string>()
  const payouts = result.payouts.map((draft: PayoutDraft, index) => {
    const label = `Payout ${index + 1}`
    if (!draft.key || payoutKeys.has(draft.key)) report(`${label}: its key is missing or repeated.`)
    payoutKeys.add(draft.key)
    if (!hasRow(draft.sourceRowNumber)) report(`${label}: it points at no source row.`)
    if (!exactDecimal.test(draft.amount)) report(`${label}: amount must be exact decimal text.`)
    if (draft.currency !== input.accountCurrency) {
      report(`${label}: currency ${draft.currency} does not match the account currency ${input.accountCurrency}.`)
    }
    if (draft.paidAt !== null && !instant.test(draft.paidAt)) report(`${label}: paid at must carry a time zone.`)
    if (draft.settlementRef !== null && !settlementIds.has(draft.settlementRef)) {
      report(`${label}: it names a settlement that is not in this file.`)
    }
    if (draft.externalRef !== null && containsEmailAddress(draft.externalRef)) {
      report(`${label}: its reference contains an email address.`)
    }
    accounted.add(draft.sourceRowNumber)

    return {
      key: draft.key,
      source_row_number: draft.sourceRowNumber,
      external_ref: draft.externalRef,
      amount: draft.amount,
      currency: draft.currency,
      paid_at: draft.paidAt,
      settlement_ref: draft.settlementRef,
    }
  })

  // ---- transactions -----------------------------------------------------------
  const lines = new Set<string>()
  const transactions = result.transactions.map((draft: TransactionDraft, index) => {
    const label = `Transaction ${index + 1}`
    if (!hasRow(draft.sourceRowNumber)) {
      report(`${label}: it points at no source row, so it would have no lineage.`)
    }
    const lineKey = `${draft.sourceRowNumber}:${draft.lineIndex}`
    if (lines.has(lineKey)) report(`${label}: row ${draft.sourceRowNumber} line ${draft.lineIndex} is repeated.`)
    lines.add(lineKey)

    if (!exactDecimal.test(draft.amount)) {
      report(`${label}: amount must be exact decimal text. A blank amount is a row issue, not a transaction.`)
    }
    if (draft.currency !== input.accountCurrency) {
      report(`${label}: currency ${draft.currency} does not match the account currency ${input.accountCurrency}.`)
    }
    if (!instant.test(draft.postedAt)) report(`${label}: posted at must carry a time zone.`)
    if (draft.quantity !== null && !exactDecimal.test(draft.quantity)) {
      report(`${label}: quantity must be exact decimal text or blank.`)
    }
    if ((draft.quantity === null) !== (draft.quantityBasis === null)) {
      report(`${label}: quantity and its basis must be given together.`)
    }
    if (draft.mappingRuleId === null && (draft.category !== UNMAPPED || draft.side !== null)) {
      report(`${label}: a transaction without a mapping rule must be UNMAPPED, with no side.`)
    }
    if (draft.mappingRuleId !== null && draft.category === UNMAPPED) {
      report(`${label}: an UNMAPPED transaction cannot have a mapping rule.`)
    }
    if (draft.settlementRef !== null && !settlementIds.has(draft.settlementRef)) {
      report(`${label}: it names a settlement that is not in this file.`)
    }
    if (draft.payoutRef !== null && !payoutKeys.has(draft.payoutRef)) {
      report(`${label}: it names a payout that is not in this file.`)
    }
    const texts = [
      draft.sourceType,
      draft.sourceSubtype,
      draft.sourceDescription,
      draft.orderRef,
      draft.orderLineRef,
      draft.rawSku,
      draft.subcategory,
    ]
    if (texts.some((text) => text !== null && containsEmailAddress(text))) {
      report(`${label}: a text field contains an email address.`)
    }
    accounted.add(draft.sourceRowNumber)

    return {
      source_row_number: draft.sourceRowNumber,
      line_index: draft.lineIndex,
      mapping_rule_id: draft.mappingRuleId,
      side: draft.side,
      category: draft.category,
      subcategory: draft.subcategory,
      source_type: draft.sourceType,
      source_subtype: draft.sourceSubtype,
      source_description: draft.sourceDescription,
      amount: draft.amount,
      currency: draft.currency,
      posted_at: draft.postedAt,
      order_ref: draft.orderRef,
      order_line_ref: draft.orderLineRef,
      raw_sku: draft.rawSku,
      quantity: draft.quantity,
      quantity_basis: draft.quantityBasis,
      attribution: draft.attribution,
      settlement_ref: draft.settlementRef,
      payout_ref: draft.payoutRef,
    }
  })

  // ---- issues -----------------------------------------------------------------
  const issues = result.issues.map((issue, index) => {
    if (!hasRow(issue.rowNumber)) report(`Row issue ${index + 1}: it points at no source row.`)
    if ([issue.message, issue.field, issue.rawValue].some((text) => text && containsEmailAddress(text))) {
      report(`Row issue ${index + 1}: it contains an email address.`)
    }
    accounted.add(issue.rowNumber)

    return {
      row_number: issue.rowNumber,
      severity: issue.severity,
      field: issue.field ?? null,
      message: issue.message,
      raw_value: issue.rawValue ?? null,
    }
  })

  // ---- nothing silently dropped -----------------------------------------------
  for (const rowNumber of rowNumbers) {
    if (!accounted.has(rowNumber)) {
      report(`Row ${rowNumber} is not used by any transaction, settlement, payout or row issue.`)
    }
  }

  if (problems.length > 0) return { ok: false, problems }

  return {
    ok: true,
    payload: {
      marketplace_account_id: input.accountId,
      format_id: input.format.id,
      adapter_version: input.format.adapterVersion,
      source_kind: input.sourceKind ?? "UPLOAD",
      file_name: input.file.name,
      file_type: input.file.type,
      file_size_bytes: input.file.sizeBytes,
      file_sha256: input.file.sha256,
      columns: [...input.columns],
      stripped_columns: [...stripped],
      rows,
      settlements,
      payouts,
      transactions,
      issues,
    },
  }
}
