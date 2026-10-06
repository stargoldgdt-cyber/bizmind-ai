import type { Metadata } from "next"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { ArrowLeft, CircleAlert, CircleCheck, TriangleAlert } from "lucide-react"

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
import { getFileSkuSummary, type FileSkuSummary } from "@/features/catalog/queries"
import { LedgerFilePanel } from "@/features/imports/components/ledger-file-panel"
import {
  LedgerFileContents,
  LedgerFileSettlements,
} from "@/features/imports/components/ledger-file-sections"
import { WithdrawPanel } from "@/features/imports/components/withdraw-panel"
import { groupOf, groupTotals, partOf } from "@/features/imports/groups"
import {
  getImportIssues,
  getLedgerFileSettlements,
  getLedgerFileSummary,
  getWithdrawalPreview,
  listDataSources,
  type DataSource,
} from "@/features/imports/queries"
import { formatNumber } from "@/lib/format"
import { createClient, getCurrentUser } from "@/lib/supabase/server"
import { importEntityLabel } from "@/services/ingestion/entities"

export const metadata: Metadata = {
  title: "Import details",
}

/**
 * One data source, in full.
 *
 * The page answers three questions in the order an owner asks them:
 *   1. what did this file put into my business?
 *   2. what did it not manage to read, and why?
 *   3. how do I take it back out?
 *
 * TENANT ISOLATION IS THE DATABASE'S, NOT THIS PAGE'S.
 * `getDataSource()` reads through the caller's own session, so an id belonging
 * to another business simply does not come back and the page 404s. Nothing
 * here filters by business id, because a filter that can be forgotten is not a
 * boundary.
 */
export default async function ImportDetailPage(props: PageProps<"/imports/[id]">) {
  const { id } = await props.params

  const [user, businesses, activeBusiness] = await Promise.all([
    getCurrentUser(),
    getUserBusinesses(),
    getActiveBusiness(),
  ])

  if (!activeBusiness) redirect(ONBOARDING_ROUTE)

  const { rows: allSources } = await listDataSources({ limit: 200 })
  const source = allSources.find((row) => row.batch_id === id)
  if (!source) notFound()

  // A large file was recorded in parts; this page speaks of the whole file and
  // lists the parts, so the owner never has to think about them.
  const group = groupOf(allSources, id)
  const totals = group ? groupTotals(group) : null
  const thisPart = partOf(source.file_name)
  const allWithdrawn = group ? totals!.withdrawn === group.parts.length : Boolean(source.withdrawn_at)
  // Withdraw what still counts; put back everything once it is all withdrawn.
  const actOn = group ? group.parts.filter((part) => (allWithdrawn ? true : !part.withdrawn_at)) : [source]

  // The preview is owner/admin-only in the database, so it is not even asked
  // for on behalf of someone who could not act on it.
  const canManage = activeBusiness.role === "OWNER" || activeBusiness.role === "ADMIN"

  // A marketplace settlement file lives in the ledger: it has its own contents,
  // its own reconciliation and its own withdrawal (migrations 0030, 0031).
  const isLedger = source.dataset === "LEDGER"

  const supabase = await createClient()
  const [{ data: profile }, issues, preview, summary, settlements, skus] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user!.id).maybeSingle(),
    getImportIssues(source.batch_id, 200),
    canManage && !isLedger ? getWithdrawalPreview(source.batch_id) : Promise.resolve(null),
    isLedger ? getLedgerFileSummary(source.batch_id) : Promise.resolve([]),
    isLedger ? getLedgerFileSettlements(source.batch_id) : Promise.resolve([]),
    isLedger ? getFileSkuSummary(source.batch_id) : Promise.resolve(null),
  ])

  return (
    <AppShell
      businesses={businesses}
      activeBusinessId={activeBusiness.id}
      userEmail={user!.email ?? ""}
      userName={profile?.full_name ?? null}
    >
      <div className="mx-auto max-w-4xl">
        <Button asChild size="sm" variant="ghost" className="mb-3 rounded-4xl">
          <Link href="/imports">
            <ArrowLeft className="size-4" aria-hidden />
            All data sources
          </Link>
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight break-all">
              {group ? group.name : source.file_name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {isLedger
                ? `Settlement file · ${source.marketplace_label ?? "Marketplace account"}`
                : `${importEntityLabel(source.entity)} · ${source.connection_name ?? source.source ?? "File"}`}{" "}
              ·{" "}
              {new Date(source.created_at).toLocaleString()}
            </p>
          </div>
          {allWithdrawn && (
            <span className="rounded-4xl bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
              Withdrawn from your figures
            </span>
          )}
        </div>

        {/* ---- what it did ------------------------------------------------ */}
        {isLedger ? (
          <>
            <section className="mt-6 rounded-xl border border-border bg-card px-5 py-4">
              <h2 className="text-sm font-semibold">What this file recorded</h2>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
                <Stat label="Rows in the file" value={totals ? totals.rows : source.row_count} />
                <Stat label="Ledger lines" value={totals ? totals.lines : source.transactions_count} />
                <Stat label="Settlements" value={totals ? totals.settlements : source.settlements_count} />
                <Stat label="Payouts reported" value={totals ? totals.payouts : source.payouts_count} />
                <Stat
                  label="Not recognised yet"
                  value={group ? group.parts.reduce((sum, part) => sum + part.unmapped_count, 0) : source.unmapped_count}
                />
              </dl>
              <p className="mt-4 max-w-prose-comfortable text-sm text-muted-foreground">
                {allWithdrawn
                  ? "Every line is still stored, but none of them counts towards anything until you put the file back."
                  : "Recorded exactly as the marketplace reported it. Nothing in the ledger is ever edited; a wrong file is withdrawn, not changed."}
              </p>
            </section>
            {group && (
              <PartsList
                parts={group.parts}
                currentId={id}
                of={group.of}
                complete={totals!.complete}
                thisPart={thisPart?.part ?? null}
              />
            )}
            {skus && skus.skus > 0 && !source.withdrawn_at && <FileSkus skus={skus} />}
            <LedgerFileSettlements settlements={settlements} />
            <LedgerFileContents summary={summary} />
          </>
        ) : (
        <section className="mt-6 rounded-xl border border-border bg-card px-5 py-4">
          <h2 className="text-sm font-semibold">What this import did</h2>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
            <Stat label="Rows in the file" value={source.row_count} />
            <Stat label="Records added" value={source.created_count} />
            <Stat label="Records updated" value={source.updated_count} />
            <Stat label="Rows skipped" value={source.rows_failed} />
            <Stat
              label="Counting today"
              value={source.withdrawn_at ? 0 : source.records_written}
            />
          </dl>

          <p className="mt-4 max-w-prose-comfortable text-sm text-muted-foreground">
            {describeOutcome(source)}
          </p>
        </section>
        )}

        {/* ---- what it could not read ------------------------------------- */}
        <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">
              Rows BizMind could not use{group && thisPart ? ` in part ${thisPart.part}` : ""} ({formatNumber(issues.length)}
              {issues.length === 200 ? "+" : ""})
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              An error means the row was not imported. A warning means it was
              imported with something missing — and that missing thing is left
              unknown, never filled in with a zero.
            </p>
          </div>

          {issues.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              Every row was read cleanly.
            </p>
          ) : (
            <div className="overflow-x-auto [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Row</TableHead>
                    <TableHead className="w-28">Severity</TableHead>
                    <TableHead className="w-40">Column</TableHead>
                    <TableHead>What happened</TableHead>
                    <TableHead>Value in the file</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {issues.map((issue) => (
                    <TableRow key={`${issue.row_number}-${issue.field}-${issue.message}`}>
                      <TableCell className="font-mono text-xs tabular-nums">
                        {issue.row_number}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center gap-1 text-xs font-medium ${
                            issue.severity === "ERROR"
                              ? "text-danger-strong"
                              : "text-warning-strong"
                          }`}
                        >
                          {issue.severity === "ERROR" ? (
                            <CircleAlert className="size-3.5" aria-hidden />
                          ) : (
                            <TriangleAlert className="size-3.5" aria-hidden />
                          )}
                          {issue.severity === "ERROR" ? "Not imported" : "Imported"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {issue.field ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">{issue.message}</TableCell>
                      <TableCell className="max-w-48 truncate font-mono text-xs text-muted-foreground">
                        {issue.raw_value ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {/* ---- taking it back out ----------------------------------------- */}
        <section className="mt-6">
          <h2 className="text-sm font-semibold">If this import was wrong</h2>
          <div className="mt-3">
            {canManage && isLedger ? (
              <LedgerFilePanel
                sourceFileIds={actOn.map((part) => part.batch_id)}
                fileName={group ? group.name : source.file_name}
                transactions={actOn.reduce((sum, part) => sum + part.transactions_count, 0)}
                settlements={actOn.reduce((sum, part) => sum + part.settlements_count, 0)}
                payouts={actOn.reduce((sum, part) => sum + part.payouts_count, 0)}
                withdrawnAt={allWithdrawn ? (group ? group.parts[0].withdrawn_at : source.withdrawn_at) : null}
                withdrawalReason={group ? group.parts[0].withdrawal_reason : source.withdrawal_reason}
              />
            ) : canManage ? (
              <WithdrawPanel
                batchId={source.batch_id}
                preview={preview}
                withdrawnAt={source.withdrawn_at}
                withdrawalReason={source.withdrawal_reason}
              />
            ) : (
              <p className="rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
                Only an owner or admin of {activeBusiness.name} can withdraw
                imported data.
              </p>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  )
}

/**
 * The one-line honest summary.
 *
 * `lineage_status` is what BizMind knows about which records this import
 * wrote. Saying it out loud is the difference between a withdraw button that
 * is missing and one that is missing for a reason.
 */
function describeOutcome(source: DataSource): string {
  if (source.withdrawn_at) {
    return "These records are still stored, with every row and problem intact, but they count towards nothing until you put them back."
  }

  switch (source.lineage_status) {
    case "RECORDED":
      return "BizMind recorded exactly which records this import wrote, so it can be taken back out of your figures at any time."
    case "RECOVERED":
      return "This import ran before BizMind tracked record history, but its records were matched back to it afterwards, so it can still be withdrawn."
    case "INCOMPLETE":
      return "Only some of this import's records could be traced back to it, so withdrawing it would leave part of its data behind. It is kept as it is."
    default:
      return "This import ran before BizMind tracked which source wrote which record, so its records cannot be separated from the rest of your data."
  }
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xl font-semibold tabular-nums">
        {value === null ? "—" : formatNumber(value)}
      </dd>
    </div>
  )
}

/** The file's marketplace SKUs: recognised from earlier setup, or new. */
function FileSkus({ skus }: { skus: FileSkuSummary }) {
  return (
    <section className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-card px-5 py-4 text-sm">
      <p className="font-semibold">{formatNumber(skus.skus)} SKUs in this file</p>
      <p className="inline-flex items-center gap-1.5 text-success-strong">
        <CircleCheck className="size-4" aria-hidden />
        {formatNumber(skus.recognised)} recognised
        {skus.matched_automatically > 0 && (
          <span className="text-muted-foreground">({formatNumber(skus.matched_automatically)} automatically)</span>
        )}
      </p>
      {skus.need_attention > 0 ? (
        <>
          <p className="inline-flex items-center gap-1.5 text-warning-strong">
            <CircleAlert className="size-4" aria-hidden />
            {formatNumber(skus.need_attention)} need product mapping
          </p>
          <Link href="/catalog#needs-attention" className="ml-auto font-medium underline underline-offset-4">
            Set them up
          </Link>
        </>
      ) : (
        <p className="text-muted-foreground">Every SKU has a product; their costs apply automatically.</p>
      )}
    </section>
  )
}

/** The parts of a file recorded in parts, each a click away. */
function PartsList({
  parts,
  currentId,
  of,
  complete,
  thisPart,
}: {
  parts: DataSource[]
  currentId: string
  of: number
  complete: boolean
  thisPart: number | null
}) {
  return (
    <section className="mt-4 rounded-xl border border-border bg-card px-5 py-4">
      <h2 className="text-sm font-semibold">Recorded in {of} parts</h2>
      <p className="mt-1 max-w-prose-comfortable text-sm text-muted-foreground">
        This is a large file, so BizMind recorded it in {of} parts to stay within the database&apos;s time limit. The
        figures above are for the whole file.
        {thisPart !== null && ` You are looking at part ${thisPart}; the rows listed below are from that part.`}
        {!complete && ` Only ${parts.length} of the ${of} parts were recorded. Upload the same file again to record the rest.`}
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {parts.map((part) => {
          const info = partOf(part.file_name)
          return (
            <li key={part.batch_id}>
              <Link
                href={`/imports/${part.batch_id}`}
                aria-current={part.batch_id === currentId ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-4xl border px-3 py-1 text-xs font-medium tabular-nums ${
                  part.batch_id === currentId
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
              >
                Part {info?.part} · {formatNumber(part.row_count)} rows{part.withdrawn_at ? " · withdrawn" : ""}
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
