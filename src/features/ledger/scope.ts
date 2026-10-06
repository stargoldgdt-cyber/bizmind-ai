import { firstParam, type SearchParams } from "@/features/ledger/params"
import type { LedgerAccount } from "@/features/ledger/queries"
import { monthKeyOf, parseLedgerMonth, type LedgerMonth } from "@/services/ledger/period"

/**
 * Which marketplace account (or every account in one currency) and which month
 * a ledger screen is showing, read from the URL.
 *
 * Product profitability and the product analysis page share it, so the choice
 * made on one carries to the other and the two can never disagree.
 */

/** "All AED accounts" travels in the URL as "all-AED". */
export const ALL_ACCOUNTS_PREFIX = "all-"

export type LedgerPeriodRow = { marketplace_account_id: string; month: string }

export type LedgerScope = {
  /** One account, or null when a whole currency is chosen. */
  account: LedgerAccount | null
  /** The currency chosen as "all accounts", or null. */
  combined: string | null
  /** The currency the figures are in, once something is chosen. */
  currency: string | null
  /** Account ids whose figures are included. */
  inScope: Set<string>
  month: LedgerMonth | null
  monthOptions: LedgerMonth[]
  /** The account picker's options, including "All <currency> accounts". */
  filterOptions: { id: string; label: string; detail: string }[]
  /** The account value the picker shows as selected. */
  selectedAccount: string
}

export function resolveLedgerScope(
  accounts: readonly LedgerAccount[],
  periods: readonly LedgerPeriodRow[],
  searchParams: SearchParams
): LedgerScope {
  const byCurrency = new Map<string, LedgerAccount[]>()
  for (const a of accounts) byCurrency.set(a.currency, [...(byCurrency.get(a.currency) ?? []), a])
  const currencyGroups = [...byCurrency.entries()].filter(([, list]) => list.length > 1)

  const requested = firstParam(searchParams.account)
  const requestedCurrency = requested?.startsWith(ALL_ACCOUNTS_PREFIX) ? requested.slice(ALL_ACCOUNTS_PREFIX.length) : null
  const combined = currencyGroups.find(([currency]) => currency === requestedCurrency)?.[0] ?? null
  const account = combined
    ? null
    : (accounts.find((a) => a.id === requested) ??
      accounts.find((a) => periods.some((p) => p.marketplace_account_id === a.id)) ??
      accounts[0] ??
      null)

  const inScope = new Set(
    combined ? (byCurrency.get(combined) ?? []).map((a) => a.id) : account ? [account.id] : []
  )
  const monthKeys = [...new Set(periods.filter((p) => inScope.has(p.marketplace_account_id)).map((p) => monthKeyOf(p.month)))]
    .sort()
    .reverse()
  const monthOptions = monthKeys.map((key) => parseLedgerMonth(key)).filter((m): m is LedgerMonth => m !== null)
  const month = parseLedgerMonth(firstParam(searchParams.month)) ?? monthOptions[0] ?? null
  if (month && !monthOptions.some((m) => m.key === month.key)) monthOptions.unshift(month)

  const filterOptions = [
    ...accounts.map((a) => ({ id: a.id, label: a.label, detail: `${a.marketplace_code} · ${a.currency}` })),
    ...currencyGroups.map(([currency, list]) => ({
      id: `${ALL_ACCOUNTS_PREFIX}${currency}`,
      label: `All ${currency} accounts`,
      detail: `${list.length} accounts, added up`,
    })),
  ]

  return {
    account,
    combined,
    currency: combined ?? account?.currency ?? null,
    inScope,
    month,
    monthOptions,
    filterOptions,
    selectedAccount: combined ? `${ALL_ACCOUNTS_PREFIX}${combined}` : (account?.id ?? ""),
  }
}
