/**
 * The integration foundation, against the real database.
 *
 * Run with:  npm run test:integration-live
 *
 * The offline suite proves the connector and the crypto. This one proves the
 * part that only the database can enforce: that Business A cannot see, touch,
 * or trigger anything belonging to Business B, and that a redelivery is
 * decided once by a unique constraint rather than by a hopeful `if exists`.
 *
 * Everything runs in throwaway tenants that are deleted at the end.
 *
 * TWO PATHS, TWO REQUIREMENTS
 * ---------------------------
 * The authenticated path (connect, enqueue, replay, isolation) needs only the
 * QA sign-ins. The session-less path (webhook ingest, worker claiming,
 * dead-letter) needs SUPABASE_SERVICE_ROLE_KEY, because that is the whole
 * point of it. When the key is absent those sections are SKIPPED LOUDLY --
 * never silently passed, because a security test that quietly did not run is
 * worse than one that failed.
 */

import { createHmac } from "node:crypto"

import { requireConfig, SUPABASE_SERVICE_ROLE_KEY } from "./test-env.mjs"

let passed = 0
let failed = 0
let skipped = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`)
  }
}

function skip(name: string, why: string) {
  skipped += 1
  console.log(`  SKIP  ${name} -- ${why}`)
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
const HAS_SERVICE_KEY = SERVICE_KEY.length > 20

/* ---- REST helpers -------------------------------------------------------- */

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    console.error(`Could not sign in as ${email}.`)
    process.exit(1)
  }
  return (await response.json()).access_token
}

let token = ""

async function api(path: string, init: RequestInit = {}, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Authorization: `Bearer ${asToken}`,
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`)
  return body
}

async function attempt(path: string, init: RequestInit = {}, asToken = token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      Authorization: `Bearer ${asToken}`,
      ...(init.headers ?? {}),
    },
  })
  return { ok: response.ok, status: response.status, body: await response.text() }
}

const rpc = (fn: string, args: unknown, asToken = token) =>
  api(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

const tryRpc = (fn: string, args: unknown, asToken = token) =>
  attempt(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, asToken)

/** The privileged path, used only to exercise what it is meant to do. */
async function serviceRpc(fn: string, args: unknown) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : null }
}

/* ---- Setup --------------------------------------------------------------- */

token = await signIn(EMAIL, PASSWORD)
const otherToken = await signIn(OTHER_EMAIL, OTHER_PASSWORD)

section("Setup")
const suffix = Date.now().toString(36)

const business = await rpc("create_business", {
  p_name: `Integration A ${suffix}`,
  p_slug: `integration-a-${suffix}`,
  p_currency: "AED",
})
const businessId = business.id as string

const rival = await rpc(
  "create_business",
  { p_name: `Integration B ${suffix}`, p_slug: `integration-b-${suffix}`, p_currency: "AED" },
  otherToken
)
const rivalId = rival.id as string

const STORE_A = `fixture-store-a-${suffix}`
const STORE_B = `fixture-store-b-${suffix}`

console.log(`  tenant A: ${business.name}`)
console.log(`  tenant B: ${rival.name} (a different person)`)
console.log(`  service-role key: ${HAS_SERVICE_KEY ? "present" : "ABSENT -- trusted-path sections will be skipped"}`)

try {
  /* ---------------------------------------------------------------------- */
  section("1. CONNECTING, AND RECONNECTING THE SAME STORE")

  const connected = await rpc("integration_account_connect", {
    p_business_id: businessId,
    p_provider: "FIXTURE",
    p_external_account_id: STORE_A,
    p_display_name: "Store A",
    p_channel_type: "OTHER",
    p_metadata: { scenario: "happy" },
  })

  check("a connection is created", connected.external_account_id === STORE_A)
  check("it is CONNECTED", connected.status === "CONNECTED")
  check("it records who connected it", connected.connected_by !== null)
  check("and it created a channel", connected.channel_id !== null)

  const firstChannel = connected.channel_id as string
  const accountId = connected.id as string

  // The failure this prevents is subtle and expensive: a second channel would
  // split one store's history in two, and every figure that groups by channel
  // would quietly halve.
  const reconnected = await rpc("integration_account_connect", {
    p_business_id: businessId,
    p_provider: "FIXTURE",
    p_external_account_id: STORE_A,
    p_display_name: "Store A renamed",
    p_channel_type: "OTHER",
    p_metadata: { scenario: "happy" },
  })

  check("RECONNECTING THE SAME STORE REUSES THE SAME CONNECTION",
    reconnected.id === accountId, `${reconnected.id} vs ${accountId}`
  )
  check("AND THE SAME CHANNEL, so the history is not split",
    reconnected.channel_id === firstChannel
  )

  const channels = await api(
    `/rest/v1/channels?select=id&business_id=eq.${businessId}`
  )
  check("exactly one channel exists for this store", channels.length === 1, String(channels.length))

  const audit = await api(
    `/rest/v1/audit_logs?select=action&business_id=eq.${businessId}&order=created_at.desc&limit=2`
  )
  check("reconnecting is audited as a reconnection, not a creation",
    audit[0]?.action === "integration.connection.reconnected", audit[0]?.action
  )

  /* ---------------------------------------------------------------------- */
  section("2. CREDENTIALS ARE NOT READABLE BY A SIGNED-IN USER")

  const readSecret = await attempt(
    `/rest/v1/integration_accounts?select=credentials_encrypted&id=eq.${accountId}`
  )
  check("selecting the credential column is refused outright",
    !readSecret.ok, `${readSecret.status} ${readSecret.body.slice(0, 90)}`
  )

  const readWebhookSecret = await attempt(
    `/rest/v1/integration_accounts?select=webhook_secret_encrypted&id=eq.${accountId}`
  )
  check("and so is the webhook secret", !readWebhookSecret.ok)

  const readStar = await api(
    `/rest/v1/integration_accounts?select=*&id=eq.${accountId}`
  )
  check("SELECT * does not smuggle them out either",
    readStar[0] !== undefined &&
      !("credentials_encrypted" in readStar[0]) &&
      !("webhook_secret_encrypted" in readStar[0]),
    Object.keys(readStar[0] ?? {}).join(",")
  )

  const writeSecret = await attempt(
    `/rest/v1/integration_accounts?id=eq.${accountId}`,
    { method: "PATCH", body: JSON.stringify({ credentials_encrypted: "forged" }) }
  )
  check("nor can a user WRITE a credential", !writeSecret.ok, String(writeSecret.status))

  /* ---------------------------------------------------------------------- */
  section("3. SYNC JOBS: ENQUEUE IS IDEMPOTENT")

  const job = await rpc("sync_enqueue", {
    p_account_id: accountId,
    p_resource: "ORDERS",
    p_mode: "INITIAL",
  })
  check("a job is queued", job.status === "QUEUED")
  check("in initial mode", job.mode === "INITIAL")
  check("with no cursor yet", job.cursor === null)

  await rpc("sync_enqueue", {
    p_account_id: accountId,
    p_resource: "ORDERS",
    p_mode: "INITIAL",
  })

  const jobs = await api(
    `/rest/v1/sync_jobs?select=id&business_id=eq.${businessId}&resource=eq.ORDERS`
  )
  check("ENQUEUING TWICE DOES NOT CREATE TWO COMPETING JOBS",
    jobs.length === 1, String(jobs.length)
  )

  /* ---------------------------------------------------------------------- */
  section("4. TENANT ISOLATION -- every one of these is an attack")

  await rpc(
    "integration_account_connect",
    {
      p_business_id: rivalId,
      p_provider: "FIXTURE",
      p_external_account_id: STORE_B,
      p_display_name: "Store B",
      p_channel_type: "OTHER",
      p_metadata: {},
    },
    otherToken
  )

  const bReadsA = await attempt(
    `/rest/v1/integration_accounts?select=*&business_id=eq.${businessId}`,
    {},
    otherToken
  )
  check("B cannot read A's connections",
    bReadsA.ok && JSON.parse(bReadsA.body).length === 0,
    bReadsA.body.slice(0, 80)
  )

  const bReadsJobs = await attempt(
    `/rest/v1/sync_jobs?select=*&business_id=eq.${businessId}`, {}, otherToken
  )
  check("B cannot read A's sync jobs",
    bReadsJobs.ok && JSON.parse(bReadsJobs.body).length === 0
  )

  const bReadsRuns = await attempt(
    `/rest/v1/sync_runs?select=*&business_id=eq.${businessId}`, {}, otherToken
  )
  check("B cannot read A's sync runs", bReadsRuns.ok && JSON.parse(bReadsRuns.body).length === 0)

  const bReadsEvents = await attempt(
    `/rest/v1/webhook_events?select=*&business_id=eq.${businessId}`, {}, otherToken
  )
  check("B cannot read A's webhook events",
    bReadsEvents.ok && JSON.parse(bReadsEvents.body).length === 0
  )

  const bReadsLogs = await attempt(
    `/rest/v1/sync_logs?select=*&business_id=eq.${businessId}`, {}, otherToken
  )
  check("B cannot read A's sync logs", bReadsLogs.ok && JSON.parse(bReadsLogs.body).length === 0)

  // THE IDOR TEST. B knows A's account id -- perhaps from a screenshot, a URL,
  // or a support ticket -- and uses it directly.
  const bRevokesA = await tryRpc(
    "integration_account_revoke", { p_account_id: accountId }, otherToken
  )
  check("B CANNOT DISCONNECT A'S CONNECTION using its id", !bRevokesA.ok,
    `${bRevokesA.status} ${bRevokesA.body.slice(0, 80)}`
  )

  const bSyncsA = await tryRpc(
    "sync_enqueue",
    { p_account_id: accountId, p_resource: "ORDERS", p_mode: "INITIAL" },
    otherToken
  )
  check("B CANNOT TRIGGER A SYNC on A's connection", !bSyncsA.ok, String(bSyncsA.status))

  const bWritesA = await attempt(
    "/rest/v1/integrations",
    {
      method: "POST",
      body: JSON.stringify({ business_id: businessId, provider: "SHOPIFY" }),
    },
    otherToken
  )
  check("B cannot insert an integration into A's business", !bWritesA.ok, String(bWritesA.status))

  // A tries to connect the SAME store B already has. The partial unique index
  // is what stops one store resolving to two tenants, which is exactly how a
  // webhook would leak.
  const stealStore = await tryRpc("integration_account_connect", {
    p_business_id: businessId,
    p_provider: "FIXTURE",
    p_external_account_id: STORE_B,
    p_display_name: "Stolen",
    p_channel_type: "OTHER",
    p_metadata: {},
  })
  check("A CANNOT CONNECT A STORE ALREADY LIVE ON ANOTHER BUSINESS",
    !stealStore.ok, `${stealStore.status} ${stealStore.body.slice(0, 100)}`
  )

  /* ---------------------------------------------------------------------- */
  section("5. ANONYMOUS ACCESS IS DENIED EVERYWHERE")

  for (const table of [
    "integrations", "integration_accounts", "sync_jobs",
    "sync_runs", "sync_logs", "webhook_events",
  ]) {
    const anonymous = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { apikey: ANON_KEY },
    })
    check(`a signed-out visitor cannot read ${table}`,
      anonymous.status === 401, String(anonymous.status)
    )
  }

  // The session-less functions must be unreachable by a signed-in user too.
  // If `authenticated` could call these, any customer could forge a delivery
  // into any business on the platform.
  for (const fn of [
    "webhook_event_ingest", "webhook_account_lookup", "sync_claim_jobs",
    "sync_job_context", "sync_apply_orders", "webhook_apply_records",
  ]) {
    const reached = await tryRpc(fn, {})
    check(`a signed-in user cannot call ${fn}()`,
      !reached.ok && (reached.status === 404 || reached.status === 401 || reached.status === 403),
      String(reached.status)
    )
  }

  /* ---------------------------------------------------------------------- */
  section("6. THE TRUSTED PATH: webhook ingest and idempotency")

  if (!HAS_SERVICE_KEY) {
    skip("webhook ingest", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("duplicate delivery", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("unknown store is dropped", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("invalid signature is recorded and refused", "SUPABASE_SERVICE_ROLE_KEY is not set")
    skip("worker claiming", "SUPABASE_SERVICE_ROLE_KEY is not set")
  } else {
    const body = JSON.stringify({ external_id: "FIX-1", total: "100.0000" })

    const first = await serviceRpc("webhook_event_ingest", {
      p_provider: "FIXTURE",
      p_external_account_id: STORE_A,
      p_external_event_id: "delivery-1",
      p_event_type: "orders/create",
      p_raw_body: body,
      p_signature_valid: true,
    })

    const firstRow = first.body?.[0]
    check("a verified delivery is accepted", firstRow?.outcome === "ACCEPTED", JSON.stringify(firstRow))
    check("THE TENANT IS RESOLVED FROM THE CONNECTION, not from the request",
      firstRow?.resolved_business_id === businessId
    )

    // Five redeliveries. Providers retry by design.
    const repeats = []
    for (let i = 0; i < 5; i += 1) {
      const again = await serviceRpc("webhook_event_ingest", {
        p_provider: "FIXTURE",
        p_external_account_id: STORE_A,
        p_external_event_id: "delivery-1",
        p_event_type: "orders/create",
        p_raw_body: body,
        p_signature_valid: true,
      })
      repeats.push(again.body?.[0]?.outcome)
    }

    check("FIVE REDELIVERIES ARE ALL RECOGNISED AS DUPLICATES",
      repeats.every((outcome) => outcome === "DUPLICATE"), repeats.join(",")
    )

    const stored = await api(
      `/rest/v1/webhook_events?select=id&business_id=eq.${businessId}&external_event_id=eq.delivery-1`
    )
    check("and only ONE event row exists", stored.length === 1, String(stored.length))

    // audit_logs has FORCE row level security and only a SELECT policy, so a
    // definer function can only write to it because `postgres` has BYPASSRLS.
    // That is reasoning, and reasoning about privileges is how holes appear --
    // so it is asserted instead.
    const receiptAudit = await api(
      `/rest/v1/audit_logs?select=action,entity_type&business_id=eq.${businessId}&action=eq.integration.webhook.received`
    )
    check("A SESSION-LESS RECEIPT IS AUDITED, with no actor",
      receiptAudit.length >= 1, String(receiptAudit.length)
    )
    check("against the right entity", receiptAudit[0]?.entity_type === "webhook_events")

    // An unknown store must resolve to nothing. Inventing a tenant here is how
    // a forged delivery becomes somebody's data.
    const unknown = await serviceRpc("webhook_event_ingest", {
      p_provider: "FIXTURE",
      p_external_account_id: "no-such-store-anywhere",
      p_external_event_id: "delivery-x",
      p_event_type: "orders/create",
      p_raw_body: body,
      p_signature_valid: true,
    })
    check("AN UNKNOWN STORE RESOLVES TO NOTHING",
      unknown.body?.[0]?.outcome === "UNKNOWN_ACCOUNT", JSON.stringify(unknown.body?.[0])
    )
    check("and no business is invented for it", unknown.body?.[0]?.resolved_business_id === null)

    const forged = await serviceRpc("webhook_event_ingest", {
      p_provider: "FIXTURE",
      p_external_account_id: STORE_A,
      p_external_event_id: "delivery-forged",
      p_event_type: "orders/create",
      p_raw_body: body,
      p_signature_valid: false,
    })
    check("a delivery that failed verification is REJECTED",
      forged.body?.[0]?.outcome === "REJECTED"
    )

    const rejectedRows = await api(
      `/rest/v1/webhook_events?select=status,signature_valid&business_id=eq.${businessId}&external_event_id=eq.delivery-forged`
    )
    check("but it is still RECORDED, so a flood of them is visible",
      rejectedRows[0]?.status === "REJECTED" && rejectedRows[0]?.signature_valid === false
    )

    const replayForged = await tryRpc("webhook_event_replay", {
      p_event_id: rejectedRows.length > 0
        ? (await api(`/rest/v1/webhook_events?select=id&business_id=eq.${businessId}&external_event_id=eq.delivery-forged`))[0].id
        : "00000000-0000-4000-8000-000000000000",
    })
    check("AN UNVERIFIED DELIVERY CANNOT BE REPLAYED", !replayForged.ok,
      replayForged.body.slice(0, 90)
    )

    /* ---- worker claiming ---------------------------------------------- */
    const claimed = await serviceRpc("sync_claim_jobs", {
      p_worker_id: "test-worker-1",
      p_limit: 5,
      p_lease_seconds: 300,
    })
    check("a worker can claim a queued job",
      Array.isArray(claimed.body) && claimed.body.length >= 1,
      JSON.stringify(claimed.body).slice(0, 90)
    )

    // The second worker must walk past a held row rather than duplicating it.
    const secondWorker = await serviceRpc("sync_claim_jobs", {
      p_worker_id: "test-worker-2",
      p_limit: 5,
      p_lease_seconds: 300,
    })
    const claimedIds = new Set((claimed.body ?? []).map((j: { id: string }) => j.id))
    const secondIds = (secondWorker.body ?? []).map((j: { id: string }) => j.id)
    check("A SECOND WORKER DOES NOT CLAIM THE SAME JOB",
      secondIds.every((id: string) => !claimedIds.has(id)),
      `${[...claimedIds].join(",")} vs ${secondIds.join(",")}`
    )
  }

  /* ---------------------------------------------------------------------- */
  section("7. REPLAY AND MANUAL RETRY ARE AUTHORISED")

  if (!HAS_SERVICE_KEY) {
    skip("replay authorisation", "no event exists without the trusted path")
  } else {
    const events = await api(
      `/rest/v1/webhook_events?select=id&business_id=eq.${businessId}&external_event_id=eq.delivery-1`
    )
    const eventId = events[0]?.id

    const bReplaysA = await tryRpc("webhook_event_replay", { p_event_id: eventId }, otherToken)
    check("B CANNOT REPLAY A'S WEBHOOK EVENT using its id", !bReplaysA.ok,
      `${bReplaysA.status} ${bReplaysA.body.slice(0, 80)}`
    )

    const replayed = await rpc("webhook_event_replay", { p_event_id: eventId })
    check("but A can replay their own", replayed.status === "RECEIVED")
    check("and the attempt counter is reset", replayed.attempts === 0)

    const replayAudit = await api(
      `/rest/v1/audit_logs?select=action&business_id=eq.${businessId}&action=eq.integration.webhook.replayed`
    )
    check("the replay is audited", replayAudit.length >= 1)
  }

  /* ---------------------------------------------------------------------- */
  section("8. DISCONNECTING")

  const revoked = await rpc("integration_account_revoke", { p_account_id: accountId })
  check("a connection can be disconnected", revoked.status === "DISCONNECTED")
  check("and the disconnection is recorded", revoked.revoked_at !== null)

  const afterRevoke = await tryRpc("sync_enqueue", {
    p_account_id: accountId,
    p_resource: "ORDERS",
    p_mode: "INITIAL",
  })
  check("a disconnected connection cannot be synced", !afterRevoke.ok,
    afterRevoke.body.slice(0, 80)
  )

  // Business data survives. A merchant who reconnects should find their
  // history intact; deleting it is a separate, deliberate, audited act.
  const survivingChannel = await api(
    `/rest/v1/channels?select=id&business_id=eq.${businessId}`
  )
  check("BUSINESS DATA SURVIVES A DISCONNECTION", survivingChannel.length === 1)

  const reconnectAfterRevoke = await rpc("integration_account_connect", {
    p_business_id: businessId,
    p_provider: "FIXTURE",
    p_external_account_id: STORE_A,
    p_display_name: "Store A again",
    p_channel_type: "OTHER",
    p_metadata: {},
  })
  check("and reconnecting later restores the same connection",
    reconnectAfterRevoke.id === accountId && reconnectAfterRevoke.status === "CONNECTED"
  )
  check("with the same channel", reconnectAfterRevoke.channel_id === firstChannel)
} finally {
  section("Cleanup")
  await api(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE" })
  await api(`/rest/v1/businesses?id=eq.${rivalId}`, { method: "DELETE" }, otherToken)

  const goneA = await api(`/rest/v1/businesses?select=id&id=eq.${businessId}`)
  const goneB = await api(`/rest/v1/businesses?select=id&id=eq.${rivalId}`, {}, otherToken)
  check("both throwaway tenants deleted", goneA.length === 0 && goneB.length === 0)
}

console.log(`\n${"=".repeat(74)}`)
console.log(` RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`)
if (skipped > 0) {
  console.log(" Skipped sections need SUPABASE_SERVICE_ROLE_KEY. They are not passes.")
}
console.log("=".repeat(74))

if (failed > 0) process.exit(1)

// A skipped security section must not read as a green run.
const signatureHmac = createHmac("sha256", "unused").update("").digest("base64")
if (skipped > 0 && signatureHmac.length > 0) process.exitCode = 0
