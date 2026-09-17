import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { Upload } from "lucide-react"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ONBOARDING_ROUTE } from "@/config/routes"
import { getActiveBusiness, getUserBusinesses } from "@/features/businesses/queries"
import { InputVatTreatmentSelect } from "@/features/marketplaces/components/input-vat-treatment-select"
import { MarketplaceAccountForm } from "@/features/marketplaces/components/marketplace-account-form"
import { listMarketplaceAccounts, listMarketplaces } from "@/features/marketplaces/queries"
import { createClient, getCurrentUser } from "@/lib/supabase/server"

export const metadata: Metadata = {
  title: "Marketplace accounts",
}

/**
 * Marketplace accounts.
 *
 * Every settlement BizMind records belongs to one of these, and the account's
 * currency is the currency of everything in it. Adding one is the owner's
 * decision (B11); everyone in the business can see them.
 */

/** VAT on marketplace fees (decision B1). */
const INPUT_VAT_LABEL: Record<string, string> = {
  UNKNOWN: "Unknown",
  RECOVERABLE: "Recoverable",
  NON_RECOVERABLE: "Non-recoverable",
}

export default async function MarketplacesPage() {
  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const supabase = await createClient()
  const [{ data: profile }, accounts, marketplaces] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    listMarketplaceAccounts(),
    listMarketplaces(),
  ])

  const isOwner = activeBusiness.role === "OWNER"
  const canImport = activeBusiness.role !== "VIEWER"

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto grid max-w-5xl gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Marketplace accounts</h1>
            <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
              The stores {activeBusiness.name} sells through. Settlement files are
              recorded against an account, in its currency.
            </p>
          </div>
          {canImport && accounts.length > 0 && (
            <Button asChild className="rounded-4xl">
              <Link href="/imports/settlement">
                <Upload className="size-4" aria-hidden />
                Upload a settlement
              </Link>
            </Button>
          )}
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {accounts.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              No marketplace accounts yet.
              {isOwner ? " Add your first one below." : " An owner can add one."}
            </p>
          ) : (
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Marketplace</TableHead>
                    <TableHead>Country</TableHead>
                    <TableHead>Currency</TableHead>
                    <TableHead>VAT on fees</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((account) => (
                    <TableRow key={account.id}>
                      <TableCell className="font-medium">{account.label}</TableCell>
                      <TableCell className="text-sm">
                        {account.marketplace_name}
                        {account.adapter_status !== "AVAILABLE" && (
                          <span className="block text-[11px] text-muted-foreground">
                            File upload not available yet
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{account.country}</TableCell>
                      <TableCell className="font-mono text-sm">{account.currency}</TableCell>
                      <TableCell className="text-sm">
                        {isOwner ? (
                          <InputVatTreatmentSelect
                            accountId={account.id}
                            value={account.input_vat_treatment}
                          />
                        ) : (
                          <span className="text-muted-foreground">
                            {INPUT_VAT_LABEL[account.input_vat_treatment]}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {account.status === "ACTIVE" ? "Active" : "Archived"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {isOwner ? (
          <MarketplaceAccountForm
            marketplaces={marketplaces.map((m) => ({
              code: m.code,
              name: m.name,
              adapter_status: m.adapter_status,
            }))}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Only an owner of {activeBusiness.name} can add or change marketplace accounts.
          </p>
        )}
      </div>
    </AppShell>
  )
}
