/**
 * Report exports to Google Sheets, against the real database (migration 0040).
 *
 * Run with:  npm run test:report-exports-ledger   (needs SUPABASE_SERVICE_ROLE_KEY)
 *
 * No real Google account is used: the database side of the write scope is
 * exercised directly, and the real worker is run where Google is not
 * connected, so it must fail safely. Proves:
 *   - only an owner or admin asks, only with Google connected, at most three at a time
 *   - a signed-in user can never claim, read, attach or finish an export
 *   - the worker reads only the export's own business's figures
 *   - the spreadsheet an export created is recorded once and can never be repointed
 *   - a retry never creates a second spreadsheet; success is audited
 */

import { requireConfig, SUPABASE_SERVICE_ROLE_KEY } from "./test-env.mjs"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`)
  }
}

function section(title: string) {
  console.log(`\n${"=".repeat(74)}\n ${title}\n${"=".repeat(74)}`)
}

const {
  url: SUPABASE_URL,
  anonKey: ANON_KEY,
  email: EMAIL,
  password: PASSWORD,
  otherEmail: OTHER_EMAIL,
  otherPassword: OTHER_PASSWORD,
} = requireConfig({ second: true })

const SERVICE_KEY = SUPABASE_SERVICE_ROLE_KEY ?? ""
if (SERVICE_KEY.length < 20) {
  console.log("  SKIP  SUPABASE_SERVICE_ROLE_KEY is not set; the export worker cannot be exercised.")
  process.exit(1)
}
process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY ??= SERVICE_KEY

type Json = ReturnType<typeof JSON.parse>
type Reply = { ok: boolean; status: number; body: Json }

async function request(path: string, init: RequestInit, token: string, apikey = ANON_KEY): Promise<Reply> {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: Json = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { ok: response.ok, status: response.status, body }
}

const rpc = (fn: string, args: unknown, token: string) =>
  request(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, token)
const service = (fn: string, args: unknown) =>
  request(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, SERVICE_KEY, SERVICE_KEY)
const read = (path: string, token: string) => request(path, { method: "GET" }, token)
const rows = (reply: Reply): Json[] => (Array.isArray(reply.body) ? reply.body : [])
const say = (reply: Reply) => `${reply.status} ${JSON.stringify(reply.body).slice(0, 300)}`

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(`Could not sign in as ${email}`)
  return (await response.json()).access_token
}

section("Setup -- two throwaway businesses")

const owner = await signIn(EMAIL, PASSWORD)
const rival = await signIn(OTHER_EMAIL, OTHER_PASSWORD)
const suffix = Date.now().toString(36)
const mine = await rpc("create_business", { p_name: `Exports Verify ${suffix}`, p_slug: `exports-verify-${suffix}`, p_currency: "AED" }, owner)
const theirs = await rpc("create_business", { p_name: `Exports Rival ${suffix}`, p_slug: `exports-rival-${suffix}`, p_currency: "AED" }, rival)
if (!mine.ok || !theirs.ok) {
  console.log(`  could not create the businesses: ${say(mine)} ${say(theirs)}`)
  process.exit(1)
}
const businessId: string = mine.body.id
const rivalBusinessId: string = theirs.body.id
const SHEET_ID = `CreatedByBizMind_${suffix}_0123456789`
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`

/** Claims until this export is claimed (other test runs may have work queued). */
async function claim(exportId: string): Promise<Json | null> {
  for (let round = 0; round < 10; round += 1) {
    const claimed = rows(await service("report_export_claim", { p_worker_id: `exports-${suffix}`, p_limit: 20 }))
    const found = claimed.find((c) => c.export_id === exportId)
    if (found) return found
    if (claimed.length === 0) return null
  }
  return null
}

try {
  /* ------------------------------------------------------------------------ */
  section("1. ASKING")

  const noGoogle = await rpc("report_export_request", { p_business_id: businessId, p_report_key: "payouts" }, owner)
  check("without Google connected, the request is refused", !noGoogle.ok && say(noGoogle).includes("Connect Google first"), say(noGoogle))

  await rpc("integration_google_authorize", { p_business_id: businessId }, owner)
  const badKey = await rpc("report_export_request", { p_business_id: businessId, p_report_key: "ledger-rows" }, owner)
  check("an unknown report is refused", !badKey.ok, say(badKey))
  const noMonth = await rpc("report_export_request", { p_business_id: businessId, p_report_key: "marketplace-profit" }, owner)
  check("a monthly report without a month is refused", !noMonth.ok && say(noMonth).includes("Choose a month"), say(noMonth))
  const rivalAsk = await rpc("report_export_request", { p_business_id: businessId, p_report_key: "payouts" }, rival)
  check("another business's user cannot ask for this business's report", !rivalAsk.ok, say(rivalAsk))

  const first = await rpc("report_export_request", { p_business_id: businessId, p_report_key: "payouts", p_month_key: "2026-07" }, owner)
  const second = await rpc("report_export_request", { p_business_id: businessId, p_report_key: "data-quality", p_month_key: "2026-07" }, owner)
  const third = await rpc("report_export_request", { p_business_id: businessId, p_report_key: "marketplace-profit", p_month_key: "2026-07" }, owner)
  const fourth = await rpc("report_export_request", { p_business_id: businessId, p_report_key: "net-profit", p_month_key: "2026-07" }, owner)
  check("the owner queues three exports", first.ok && second.ok && third.ok, [first, second, third].map(say).join(" | "))
  check("a fourth waits: at most three at a time", !fourth.ok && say(fourth).includes("Three exports"), say(fourth))
  const queued = rows(await read(`/rest/v1/report_exports?select=id,status,month_key,report_key&business_id=eq.${businessId}`, owner))
  check("members see them QUEUED; a data-quality export has no month",
    queued.length === 3 && queued.every((q) => q.status === "QUEUED") &&
      queued.find((q) => q.report_key === "data-quality")?.month_key === null,
    JSON.stringify(queued))
  check("another business sees none of them",
    rows(await read(`/rest/v1/report_exports?select=id&business_id=eq.${businessId}`, rival)).length === 0)
  const direct = await request("/rest/v1/report_exports", {
    method: "POST", body: JSON.stringify({ business_id: businessId, report_key: "payouts", spreadsheet_id: SHEET_ID }),
  }, owner)
  check("nobody can write an export row directly (or name a spreadsheet)", !direct.ok, say(direct))
  const audit = rows(await read(`/rest/v1/audit_logs?select=id&business_id=eq.${businessId}&action=eq.report.export_requested`, owner))
  check("each request is audited", audit.length === 3, String(audit.length))

  /* ------------------------------------------------------------------------ */
  section("2. ONLY THE WORKER CAN RUN ONE")

  for (const [fn, args] of [
    ["report_export_claim", { p_worker_id: "me", p_limit: 1 }],
    ["report_export_data", { p_export_id: first.body }],
    ["report_export_attach", { p_export_id: first.body, p_spreadsheet_id: SHEET_ID, p_spreadsheet_url: SHEET_URL }],
    ["report_export_complete", { p_export_id: first.body, p_status: "SUCCEEDED" }],
  ] as const) {
    const attempt = await rpc(fn, args, owner)
    check(`a signed-in owner cannot call ${fn}`, !attempt.ok, say(attempt))
  }
  const notRunning = await service("report_export_data", { p_export_id: first.body })
  check("figures are handed out only for a running export", !notRunning.ok, say(notRunning))

  /* ------------------------------------------------------------------------ */
  section("3. A SUCCESSFUL EXPORT (the database side)")

  const claimed = await claim(first.body)
  check("the worker claims it, with the business's name and no Google credential stored in this test",
    claimed?.business_id === businessId && claimed?.report_key === "payouts" && claimed?.credentials_encrypted === null &&
      claimed?.attempts === 1,
    JSON.stringify(claimed && { ...claimed, credentials_encrypted: claimed.credentials_encrypted === null ? null : "(sealed)" }))

  const data = await service("report_export_data", { p_export_id: first.body })
  check("its figures are this export's business's, and only its",
    data.ok && String(data.body?.business_name).startsWith("Exports Verify") && Array.isArray(data.body?.data?.payouts) &&
      Array.isArray(data.body?.data?.cashflow) && !JSON.stringify(data.body).includes(rivalBusinessId),
    say(data))

  const wrongUrl = await service("report_export_attach", {
    p_export_id: first.body, p_spreadsheet_id: SHEET_ID, p_spreadsheet_url: "https://docs.google.com/spreadsheets/d/SOMEONE_ELSES_SHEET_0123456789/edit",
  })
  check("the recorded link must be the created spreadsheet's own", !wrongUrl.ok, say(wrongUrl))
  const attached = await service("report_export_attach", { p_export_id: first.body, p_spreadsheet_id: SHEET_ID, p_spreadsheet_url: SHEET_URL })
  check("the created spreadsheet is recorded", attached.ok, say(attached))
  const again = await service("report_export_attach", {
    p_export_id: first.body, p_spreadsheet_id: `Other_${SHEET_ID}`, p_spreadsheet_url: `https://docs.google.com/spreadsheets/d/Other_${SHEET_ID}/edit`,
  })
  check("and cannot be replaced by another", !again.ok && say(again).includes("already has its spreadsheet"), say(again))
  const repoint = await request(`/rest/v1/report_exports?id=eq.${first.body}`, {
    method: "PATCH", body: JSON.stringify({ spreadsheet_id: `Hijack_${SHEET_ID}` }),
  }, SERVICE_KEY, SERVICE_KEY)
  check("not even the worker's key can repoint it directly", !repoint.ok && say(repoint).includes("cannot be changed"), say(repoint))

  const done = await service("report_export_complete", { p_export_id: first.body, p_status: "SUCCEEDED" })
  const finished = rows(await read(`/rest/v1/report_exports?select=status,spreadsheet_url,error&id=eq.${first.body}`, owner))[0]
  check("it succeeds, and the owner sees the link to the new sheet",
    done.body === "SUCCEEDED" && finished?.status === "SUCCEEDED" && finished?.spreadsheet_url === SHEET_URL,
    `${say(done)} ${JSON.stringify(finished)}`)
  const exported = rows(await read(
    `/rest/v1/audit_logs?select=after_data&business_id=eq.${businessId}&action=eq.report.exported_to_sheets`, owner
  ))
  check("the export is audited with its spreadsheet", exported[0]?.after_data?.spreadsheet_id === SHEET_ID, JSON.stringify(exported))
  const twice = await service("report_export_complete", { p_export_id: first.body, p_status: "FAILED" })
  check("a finished export cannot be finished again", !twice.ok, say(twice))

  /* ------------------------------------------------------------------------ */
  section("4. RETRIES AND FAILURES")

  await claim(second.body)
  const retry = await service("report_export_complete", { p_export_id: second.body, p_status: "RETRY", p_error: "Google was busy" })
  check("a retry before any spreadsheet exists goes back to the queue", retry.body === "QUEUED", say(retry))

  const reclaimed = await claim(second.body)
  const secondSheet = `Second_${SHEET_ID}`
  await service("report_export_attach", {
    p_export_id: second.body, p_spreadsheet_id: secondSheet, p_spreadsheet_url: `https://docs.google.com/spreadsheets/d/${secondSheet}/edit`,
  })
  const retryAfterCreate = await service("report_export_complete", { p_export_id: second.body, p_status: "RETRY" })
  check("once a spreadsheet exists, a retry ends the export instead of creating a second one",
    reclaimed?.attempts === 2 && retryAfterCreate.body === "FAILED", `${JSON.stringify(reclaimed?.attempts)} ${say(retryAfterCreate)}`)

  const successWithout = await (async () => {
    await claim(third.body)
    return service("report_export_complete", { p_export_id: third.body, p_status: "SUCCEEDED" })
  })()
  check("an export cannot succeed without the spreadsheet it created", !successWithout.ok, say(successWithout))

  const { runReportExports } = await import("../src/services/integrations/sync/report-exports")
  await service("report_export_complete", { p_export_id: third.body, p_status: "RETRY" })
  const run = await runReportExports({ workerId: `exports-run-${suffix}`, limit: 20 })
  const third_ = rows(await read(`/rest/v1/report_exports?select=status,error,spreadsheet_id&id=eq.${third.body}`, owner))[0]
  check("the real worker, with no Google credential stored, fails the export safely and writes nowhere",
    run.claimed >= 1 && third_?.status === "FAILED" && third_?.spreadsheet_id === null &&
      String(third_?.error).includes("Google is not connected"),
    `${JSON.stringify(run)} ${JSON.stringify(third_)}`)
} catch (error) {
  failed += 1
  console.log(`\n  FAIL  the suite stopped early: ${(error as Error).message}`)
} finally {
  const removed = await request(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" }, owner)
  const removedRival = await request(`/rest/v1/businesses?id=eq.${rivalBusinessId}`, { method: "DELETE" }, rival)
  check("the throwaway businesses are deleted, with their exports", removed.ok && removedRival.ok,
    `${say(removed)} ${say(removedRival)}`)

  console.log(`\n${"=".repeat(74)}`)
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log("=".repeat(74))
}

process.exit(failed === 0 ? 0 : 1)
